import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_ASSISTANT_TITLE_LENGTH,
  mentionNodeIds,
  type AssetId,
  type AssistantMessage,
  type AssistantReference,
  type AssistantRole,
  type CanvasDocument,
  type CanvasId,
  type NodeId,
  type ResourceEntry,
  type RunId,
  type SessionId,
} from "../../shared/domain";
import { modelOptionsFor, useProviderStore } from "../settings/providerStore";
import {
  buildIssueIndex,
  buildResourceIndex,
} from "../editor/canvas/mediaCards";
import { mentionGroups, type MentionWanted } from "../editor/canvas/mentions";
import { MentionField } from "../editor/components/MentionField";
import {
  GENERATION_UNAVAILABLE,
  useGenerationAvailable,
} from "../editor/stores/appStore";
import { useEditorStore } from "../editor/stores/editorStore";
import {
  useActiveCanvas,
  useProjectStore,
} from "../editor/stores/projectStore";
import {
  ASSISTANT_INTENTS,
  INTENT_HINTS,
  INTENT_LABELS,
  INTENT_PLACEHOLDERS,
  askOf,
  capabilityFor,
  referenceNodes,
  referenceSummary,
  upstreamOf,
} from "./asking";
import { useAssistantStore } from "./assistantStore";
import {
  answerFile,
  copyWords,
  fileAnswer,
  overwriteCard,
  overwriteTarget,
  runsOfAssets,
  showOnCanvas,
} from "./answers";
import { sessionShown } from "./conversation";

const ROLE_WORDS: Record<AssistantRole, string> = {
  user: "You",
  assistant: "Assistant",
  error: "Trouble",
};

/**
 * The select's value for a conversation nothing has been said in yet.
 *
 * Held in the same field as the ids because the control offers both kinds and
 * one of them has to be chosen; no conversation can be mistaken for it, since an
 * id is made as a UUID.
 */
const FRESH_OPTION = "fresh";

/** How many lines a conversation holds, said so that one reads as one. */
function lineWords(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

/**
 * One line of a conversation, whether it was kept or is still arriving.
 *
 * The same shape for both, so an answer coming in reads as the line it is about
 * to become rather than as something else that is replaced when it lands.
 */
function Line({
  role,
  words,
  about,
  actions,
}: {
  role: AssistantRole;
  words: string;
  about?: readonly AssistantReference[];
  actions?: ReactNode;
}) {
  return (
    <li className={`assistant-line is-${role}`}>
      <p className="assistant-line-who">{ROLE_WORDS[role]}</p>
      <p className="assistant-line-words">{words}</p>
      {about && about.length > 0 && (
        <ul aria-label="What this was about" className="assistant-line-about">
          {about.map((reference) => (
            <li key={reference.nodeId}>{reference.title}</li>
          ))}
        </ul>
      )}
      {actions}
    </li>
  );
}

/**
 * What a kept line can be done with.
 *
 * Only kept lines: an answer still arriving has nothing to file yet, and a
 * question is already on the canvas as the cards it was about.
 */
function LineActions({
  canvas,
  chosen,
  line,
  filed,
}: {
  canvas: CanvasDocument;
  chosen: readonly NodeId[];
  line: AssistantMessage;
  filed: Map<RunId, readonly ResourceEntry[]>;
}) {
  const made = line.toolCalls?.[0];
  if (made) {
    const onto = made.nodeId;
    return (
      <div className="assistant-line-actions">
        {onto !== undefined && (
          <button onClick={() => showOnCanvas(canvas, onto)} type="button">
            Show on canvas
          </button>
        )}
        {(filed.get(made.runId)?.length ?? 0) > 0 && (
          <button
            onClick={() => useEditorStore.getState().openResourcesPanel()}
            type="button"
          >
            Show in assets
          </button>
        )}
      </div>
    );
  }
  if (line.role !== "assistant" || line.text.trim() === "") return null;
  const target = overwriteTarget(canvas, chosen);
  const file = answerFile(line.text);
  return (
    <div className="assistant-line-actions">
      <button onClick={() => fileAnswer(canvas, line.text)} type="button">
        Insert on canvas
      </button>
      {target !== null && (
        <button onClick={() => overwriteCard(target, line.text)} type="button">
          Replace selection
        </button>
      )}
      <button onClick={() => void copyWords(line.text)} type="button">
        Copy text
      </button>
      <a download={file.name} href={file.href}>
        Download
      </a>
    </div>
  );
}

/**
 * The conversations this canvas has, and what to do with them.
 *
 * A list of them at the head of the panel rather than a stack of tabs, because
 * the panel shows one at a time: the reader is here to say something, and a
 * conversation is picked to go back to rather than to keep two in view.
 *
 * Every change is written through the document, so a conversation taken away is
 * one thing to undo and a project reopened holds what it held.
 */
function Conversations({ canvas }: { canvas: CanvasDocument }) {
  const shown = useAssistantStore((state) => state.shown);
  const [renaming, setRenaming] = useState<SessionId | null>(null);
  const [title, setTitle] = useState("");

  const sessions = [...(canvas.sessions ?? [])].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const carrying = sessionShown(canvas, shown);

  const commitRename = () => {
    const held = renaming;
    setRenaming(null);
    if (held !== null) {
      useAssistantStore.getState().rename(canvas, held, title);
    }
  };

  return (
    <div className="assistant-sessions">
      {renaming === null ? (
        <select
          aria-label="Conversation"
          data-testid="assistant-session-select"
          onChange={(event) =>
            useAssistantStore
              .getState()
              .show(
                event.target.value === FRESH_OPTION
                  ? "fresh"
                  : event.target.value,
              )
          }
          title="Which conversation this panel is reading"
          value={carrying?.id ?? FRESH_OPTION}
        >
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {`${session.title} · ${lineWords(session.messages.length)}`}
            </option>
          ))}
          <option value={FRESH_OPTION}>New conversation</option>
        </select>
      ) : (
        <input
          aria-label="Conversation name"
          autoFocus
          data-testid="assistant-session-rename"
          maxLength={MAX_ASSISTANT_TITLE_LENGTH}
          onBlur={commitRename}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") setRenaming(null);
          }}
          value={title}
        />
      )}
      <div className="assistant-session-actions">
        <button
          disabled={carrying === null || renaming !== null}
          onClick={() => {
            if (!carrying) return;
            setTitle(carrying.title);
            setRenaming(carrying.id);
          }}
          title="Give this conversation another name"
          type="button"
        >
          Rename
        </button>
        <button
          disabled={carrying === null}
          onClick={() => {
            if (carrying) {
              useAssistantStore.getState().remove(canvas, carrying.id);
            }
          }}
          title="Take this conversation and its lines away"
          type="button"
        >
          Remove
        </button>
        <button
          className="danger"
          disabled={sessions.length === 0}
          onClick={() => useAssistantStore.getState().removeEvery(canvas)}
          title="Take every conversation on this canvas away, as one thing to undo"
          type="button"
        >
          Remove all
        </button>
      </div>
    </div>
  );
}

/**
 * The conversation had over the canvas, in the column beside it.
 *
 * A column and not a floating panel, because a conversation is read top to
 * bottom and typed at the foot of, which is a shape a column already has. It
 * shares the column with the inspector rather than standing beside it: a canvas
 * with a resources column, an inspector and a conversation around it has very
 * little of itself left to look at.
 *
 * What is typed and what is arriving are held outside the document until the
 * turn is over, so a question is one thing to undo and one save rather than a
 * hundred of each.
 */
export function AssistantPanel() {
  const canvas = useActiveCanvas();
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const chosen = useEditorStore((state) => state.selection.nodeIds);
  const generationOn = useGenerationAvailable();
  const providers = useProviderStore((state) => state.view);
  const intent = useAssistantStore((state) => state.intent);
  const draft = useAssistantStore((state) => state.draft);
  const asking = useAssistantStore((state) => state.asking);
  const saying = useAssistantStore((state) => state.saying);
  const busy = useAssistantStore((state) => state.busy);
  const shown = useAssistantStore((state) => state.shown);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const canvasId = canvas?.id ?? null;
  const shownFor = useRef<CanvasId | null>(canvasId);

  // Built once per document rather than once per keystroke: a project may hold
  // thousands of assets and the field asks after every one of them.
  const resources = useMemo(
    () => (moka ? buildResourceIndex(moka) : new Map<AssetId, ResourceEntry>()),
    [moka],
  );
  const issues = useMemo(() => buildIssueIndex(selfCheck), [selfCheck]);
  const filed = useMemo(
    () =>
      moka ? runsOfAssets(moka) : new Map<RunId, readonly ResourceEntry[]>(),
    [moka],
  );

  // Keyed on what the question names rather than on its words. Finding what
  // feeds the chosen cards means walking the wires and looking each card up in
  // a list, which is worth doing when the set of cards changes and not on every
  // character of the sentence being typed about them.
  const named = mentionNodeIds(draft).join(" ");
  const about = useMemo(
    () =>
      canvas
        ? referenceNodes(canvas, chosen, named === "" ? [] : named.split(" "))
        : [],
    [canvas, chosen, named],
  );
  const planned = useMemo(
    () => (canvas ? askOf(intent, about, draft) : null),
    [canvas, intent, about, draft],
  );

  /**
   * What may be named in the question: the cards it is already about first,
   * then everything else on the board that holds something.
   */
  const offered = useMemo(() => {
    if (!canvas) return [];
    const wanted: MentionWanted[] = [];
    for (const id of chosen) wanted.push({ id, origin: "reference" });
    for (const id of upstreamOf(canvas, chosen)) {
      wanted.push({ id, origin: "upstream" });
    }
    for (const node of canvas.nodes)
      wanted.push({ id: node.id, origin: "canvas" });
    return mentionGroups(canvas, wanted, resources, issues);
  }, [canvas, chosen, resources, issues]);

  // A question typed about one canvas is not a question about another, so what
  // is typed goes when the board under it does, and the conversation on show is
  // the one that board was last being talked in rather than the one left picked.
  useEffect(() => {
    if (shownFor.current === canvasId) return;
    shownFor.current = canvasId;
    const assistant = useAssistantStore.getState();
    assistant.setDraft("");
    assistant.show("newest");
  }, [canvasId]);

  // Kept in view as it grows, since the newest line is the one being read.
  useEffect(() => {
    const end = endRef.current;
    if (end && typeof end.scrollIntoView === "function") {
      end.scrollIntoView({ block: "nearest" });
    }
  }, [asking, saying]);

  const lines = canvas ? (sessionShown(canvas, shown)?.messages ?? []) : [];
  const summary = referenceSummary(planned?.references ?? []);
  const capability = capabilityFor(intent);
  const noModel =
    providers !== null && modelOptionsFor(providers, capability).length === 0;
  // A configuration still being read is not one with nothing in it.
  const refusal = !generationOn
    ? GENERATION_UNAVAILABLE
    : noModel
      ? `No ${capability} model is configured yet.`
      : null;
  const canAsk =
    !busy && refusal === null && canvas !== null && draft.trim() !== "";

  const send = () => {
    if (!canvas || !canAsk) return;
    void useAssistantStore.getState().ask({ canvas, chosen });
  };

  return (
    <aside
      aria-label="Assistant"
      className="assistant-panel"
      data-testid="assistant-panel"
    >
      <h2>Assistant</h2>

      {canvas === null ? (
        <p className="prompt-panel-note">No canvas is open.</p>
      ) : (
        <>
          <Conversations canvas={canvas} />

          <div className="assistant-lines" data-testid="assistant-lines">
            {lines.length === 0 && !busy && (
              <p className="prompt-panel-note">
                {shown === "fresh"
                  ? "A new conversation, nothing said in it yet."
                  : "Nothing has been asked over this canvas yet."}
              </p>
            )}
            <ol>
              {lines.map((line) => (
                <Line
                  about={line.references}
                  actions={
                    <LineActions
                      canvas={canvas}
                      chosen={chosen}
                      filed={filed}
                      line={line}
                    />
                  }
                  key={line.id}
                  role={line.role}
                  words={line.text}
                />
              ))}
              {asking !== null && <Line role="user" words={asking} />}
              {busy && <Line role="assistant" words={saying || "…"} />}
            </ol>
            <div ref={endRef} />
          </div>

          <p className="assistant-about" data-testid="assistant-about">
            {summary === ""
              ? "About nothing yet — choose a card, or name one with @."
              : `About ${summary}`}
          </p>

          <div
            aria-label="What to ask for"
            className="prompt-panel-modes"
            role="group"
          >
            {ASSISTANT_INTENTS.map((option) => (
              <button
                aria-pressed={option === intent}
                className={option === intent ? "is-active" : ""}
                key={option}
                onClick={() => useAssistantStore.getState().setIntent(option)}
                title={INTENT_HINTS[option]}
                type="button"
              >
                {INTENT_LABELS[option]}
              </button>
            ))}
          </div>

          {refusal !== null ? (
            <div className="prompt-panel-models">
              <p className="prompt-panel-note" role="alert">
                {refusal}
              </p>
              {noModel && generationOn && (
                <button
                  onClick={() =>
                    useProviderStore.getState().openSettings("channels")
                  }
                  type="button"
                >
                  Configure models
                </button>
              )}
            </div>
          ) : (
            <>
              <MentionField
                canvas={canvas}
                choices={offered}
                inputRef={areaRef}
                issues={issues}
                label="Ask about this canvas"
                onChange={(next) => useAssistantStore.getState().setDraft(next)}
                onCommit={() => {}}
                onDismiss={() => areaRef.current?.blur()}
                onOffer={() => {}}
                onSubmit={send}
                placeholder={INTENT_PLACEHOLDERS[intent]}
                resources={resources}
                value={draft}
              />

              {planned !== null && planned.leftOut > 0 && (
                <p className="prompt-panel-warn" role="alert">
                  {planned.leftOut}{" "}
                  {planned.leftOut === 1 ? "card is" : "cards are"} too much to
                  send with one question and stayed behind.
                </p>
              )}

              <div className="assistant-actions">
                {busy ? (
                  <button
                    className="danger"
                    onClick={() => useAssistantStore.getState().stop()}
                    type="button"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    aria-label={`Send: ${INTENT_LABELS[intent]}`}
                    className="primary"
                    disabled={!canAsk}
                    onClick={send}
                    type="button"
                  >
                    {INTENT_LABELS[intent]}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
