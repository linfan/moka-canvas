import { useEffect, useRef, useState } from "react";
import { assetUrl, generateApi } from "../../../api";
import { CAPABILITY_LABELS } from "../../../shared/domain";
import {
  describeDefaultPrompt,
  describeFramingPrompt,
} from "../../../shared/prompts";
import { useModelStore } from "../../settings/modelStore";
import { buildResourceIndex } from "../canvas/mediaCards";
import { fileDescription } from "../interactions/actions";
import {
  GENERATION_UNAVAILABLE,
  useGenerationAvailable,
} from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { TOOL_LABELS } from "../stores/toolPrefs";

/**
 * What is asked before anybody has said otherwise.
 *
 * The words live in `shared/prompts/editor/describe-default.tmpl`.
 */
const START_QUESTION = describeDefaultPrompt();

/**
 * How the answer is framed.
 *
 * Sent rather than left to the standing instruction for written answers, which
 * says how to be answered in general: this ask wants one particular thing, words
 * a picture could be made from and nothing around them. A description that
 * arrives wrapped in an announcement of itself has to be unwrapped by hand before
 * it is any use as a prompt. The words live in
 * `shared/prompts/editor/describe-framing.tmpl`.
 */
const FRAMING = describeFramingPrompt();

/**
 * Asks a model to read a picture back as the words that would make it.
 *
 * The other half of a generation: a picture arrived from somewhere and what made
 * it is not written down, so the words are read out of it instead. They are asked
 * for here rather than filed silently, because an ask costs what an ask costs and
 * the question, the picture and the model that will answer are all things a
 * reader should see before spending.
 *
 * What comes back is filed as a text node wired into the picture's prompt, which
 * makes the picture askable again from the words it was read back as. The answer
 * is shown as it arrives so that a model answering about nothing — one that
 * cannot see — is caught here rather than after a second generation spent on its
 * guess.
 */
export function DescribeDialog() {
  const asked = useEditorStore((state) => state.pictureTool);
  const moka = useProjectStore((state) => state.moka);
  const view = useModelStore((state) => state.view);
  const reachable = useGenerationAvailable();
  const [question, setQuestion] = useState(START_QUESTION);
  const [said, setSaid] = useState("");
  const [unread, setUnread] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Held so an answer still arriving can be let go of, from a key or from the
  // dialog going away: a stream nobody is going to read still costs what
  // finishing it costs.
  const asking = useRef<AbortController | null>(null);

  const reading = asked?.tool === "describe" ? asked : null;
  const key = reading ? `${reading.nodeId}:${reading.assetId}` : null;

  useEffect(() => {
    if (!reading) return;
    setQuestion(START_QUESTION);
    setSaid("");
    setUnread(false);
    setFailed(null);
    setBusy(false);
    // Let go on the way out as well: the dialog is closed, or open for a
    // different picture, and either way the answer belongs to nobody now.
    return () => asking.current?.abort();
    // The key is the ask: what was said belongs to the picture this dialog came
    // up for, and not to the one before it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Escape lets go of an answer still arriving and closes the dialog otherwise:
  // one key, and the nearer thing first. Letting go is not closing, because the
  // words that got that far are worth reading.
  useEffect(() => {
    if (!reading) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const running = asking.current;
      if (running) {
        running.abort();
        return;
      }
      useEditorStore.getState().closePictureTool();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!reading) return null;
  const entry = moka
    ? buildResourceIndex(moka).get(reading.assetId)
    : undefined;
  if (!entry) return null;

  const close = () => useEditorStore.getState().closePictureTool();
  const reference = view?.defaults.text ?? null;
  const chosen =
    (reference !== null
      ? view?.models.find((one) => one.id === reference)
      : null) ?? null;
  const refusal = !reachable
    ? GENERATION_UNAVAILABLE
    : reference === null
      ? `No ${CAPABILITY_LABELS.text.toLowerCase()} model is configured yet`
      : question.trim() === ""
        ? "Say what to ask about the picture"
        : null;

  const submit = async () => {
    if (busy || refusal || !reference) return;
    setBusy(true);
    setFailed(null);
    setSaid("");
    const stop = new AbortController();
    asking.current = stop;
    // Gathered beside the state rather than read out of it: what a closure sees
    // of a state variable is what it was when the closure was made, and an answer
    // arrives in pieces.
    let gathered = "";
    try {
      const answer = await generateApi.textStream(
        {
          capability: "text",
          model: reference,
          prompt: question.trim(),
          system: FRAMING,
          inputs: [{ role: "reference", assetId: reading.assetId }],
        },
        (piece) => {
          gathered += piece;
          setSaid(gathered);
        },
        stop.signal,
      );
      // The whole answer rather than the pieces shown: what gets filed is what
      // the server settled on, which is the aggregate of the stream.
      const words = (answer.text ?? gathered).trim();
      if (words === "") {
        setFailed(
          "Nothing came back to file. Ask in other words, or check that the model can see a picture at all.",
        );
        return;
      }
      const filed = fileDescription({
        nodeId: reading.nodeId,
        sourceName: entry.name,
        words,
      });
      if (filed) close();
      else setFailed("The words could not be filed on this canvas");
    } catch (error) {
      // Let go of on purpose: nothing to report, and the words that arrived stay
      // on screen to be read.
      if ((error as Error).name === "AbortError") return;
      setFailed(
        error instanceof Error
          ? error.message
          : "The picture could not be read",
      );
    } finally {
      asking.current = null;
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <form
        aria-labelledby="describe-title"
        aria-modal="true"
        className="dialog tool-dialog"
        data-testid="describe-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        role="dialog"
      >
        <h2 id="describe-title">
          {TOOL_LABELS.describe} — {entry.name}
        </h2>
        <p className="dialog-note">
          Ask a model to read this picture back as the words that would make it.
          The words become a text node of their own, wired into this picture's
          prompt, so they can be read, corrected and let go of on the canvas
          rather than hiding in a field — and the picture is one press from
          being generated again from them. This is an ask, and it costs what an
          ask costs.
        </p>

        <div className="tool-stage">
          <div className="tool-frame">
            <img
              alt={entry.name}
              onError={() => setUnread(true)}
              src={assetUrl(reading.assetId)}
            />
          </div>
        </div>

        <div className="tool-params">
          <label className="dialog-field">
            <span>What to ask about the picture</span>
            <textarea
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              value={question}
            />
          </label>
        </div>

        <p
          className={
            chosen === null || reference === null
              ? "dialog-error"
              : "dialog-note"
          }
        >
          {reference === null
            ? "No model is chosen for written answers, so there is nothing to ask."
            : chosen === null
              ? "The model this would be asked through is gone, so there is nothing to ask."
              : `Asked through ${chosen.displayName} as ${chosen.model}. A model that cannot see a picture will answer about the question alone, which reads as a description of nothing — Escape lets go of an answer still arriving.`}
        </p>

        {unread && (
          <p className="dialog-note">
            The picture cannot be shown here, but it is still sent as it is
            stored.
          </p>
        )}

        {busy && (
          <p aria-live="polite" className="dialog-note">
            Reading the picture…
          </p>
        )}
        {said.trim() !== "" && (
          <div className="dialog-answer" data-testid="describe-answer">
            {said}
          </div>
        )}

        {failed && <p className="dialog-error">{failed}</p>}
        {refusal && <p className="dialog-error">{refusal}</p>}

        <div className="dialog-actions">
          <button disabled={busy} onClick={close} type="button">
            Cancel
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy || refusal !== null}
            title={refusal ?? undefined}
            type="submit"
          >
            {busy ? "Reading…" : "Ask"}
          </button>
        </div>
      </form>
    </div>
  );
}
