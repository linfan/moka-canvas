import { useEffect, useMemo, useRef } from "react";
import type {
  AssetId,
  AssistantReference,
  AssistantRole,
  CanvasId,
  ResourceEntry,
} from "../../shared/domain";
import { mentionNodeIds } from "../../shared/domain";
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
import { latestSession } from "./conversation";

const ROLE_WORDS: Record<AssistantRole, string> = {
  user: "You",
  assistant: "Assistant",
  error: "Trouble",
};

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
}: {
  role: AssistantRole;
  words: string;
  about?: readonly AssistantReference[];
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
    </li>
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
  // is typed goes when the board under it does.
  useEffect(() => {
    if (shownFor.current === canvasId) return;
    shownFor.current = canvasId;
    useAssistantStore.getState().setDraft("");
  }, [canvasId]);

  // Kept in view as it grows, since the newest line is the one being read.
  useEffect(() => {
    const end = endRef.current;
    if (end && typeof end.scrollIntoView === "function") {
      end.scrollIntoView({ block: "nearest" });
    }
  }, [asking, saying]);

  const lines = latestSession(canvas?.sessions ?? [])?.messages ?? [];
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
          <div className="assistant-lines" data-testid="assistant-lines">
            {lines.length === 0 && !busy && (
              <p className="prompt-panel-note">
                Nothing has been asked over this canvas yet.
              </p>
            )}
            <ol>
              {lines.map((line) => (
                <Line
                  about={line.references}
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
