import { useEffect, useId, useMemo, useState } from "react";
import type {
  AssetId,
  CanvasDocument,
  MentionSpan,
  ResourceEntry,
  WorkflowNode,
} from "../../../shared/domain";
import { findNode, mentionSpans } from "../../../shared/domain";
import {
  mediaInfoForNode,
  type MediaCardInfo,
  type MediaState,
} from "../canvas/mediaCards";
import {
  MENTION_HOVER_CHARS,
  mentionBeingTyped,
  mentionToken,
  narrowMentions,
  type MentionChoice,
  type MentionGroup,
} from "../canvas/mentions";

/** What a chip summons when it is hovered: the picture, or the start of a text. */
function MentionLook({
  node,
  media,
}: {
  node: WorkflowNode;
  media: MediaCardInfo | null;
}) {
  const words = (node.data as { content?: string }).content ?? "";
  return (
    <div className="mention-look" data-testid="mention-look">
      {media?.url && (
        <img alt="" className="mention-look-picture" src={media.url} />
      )}
      {node.kind === "text" && (
        <p className="mention-look-words">
          {words.replace(/\s+/g, " ").trim().slice(0, MENTION_HOVER_CHARS)}
        </p>
      )}
      <p className="mention-look-label">{media?.label ?? node.title}</p>
    </div>
  );
}

/** A candidate row, carrying the place it holds in the keyboard's own list. */
interface OfferRow {
  label: string;
  index: number;
  choice: MentionChoice;
}

/**
 * The prompt field, which knows that `@[node:<id>]` points at another card
 * rather than being prose.
 *
 * A textarea with the mentions offered over it and listed under it, rather than
 * a rich field with the tokens hidden inside. A token is forty-four characters
 * across and a chip is not, so a chip laid over the words would put every
 * character behind it somewhere the caret is not — and an input method
 * composing under a transparent caret composes where nobody can read it. So the
 * words stay in a field where the caret, the selection and the input method all
 * already work, and what the field points at is drawn as chips carrying the
 * pictures.
 *
 * The token is still what reaches the document, which is what the resolver
 * reads; the chips are a way of seeing one and of taking one out, and taking one
 * out with the keyboard removes the whole of it rather than a bracket at a time.
 */
export function MentionField({
  canvas,
  choices,
  resources,
  issues,
  value,
  label,
  placeholder,
  inputRef,
  onChange,
  onCommit,
  onSubmit,
  onDismiss,
  onOffer,
}: {
  canvas: CanvasDocument;
  /**
   * What may be mentioned, worked out by whoever owns the field.
   *
   * Offered rather than derived here because a field that belongs to a node and
   * a field that belongs to a conversation do not mean the same thing by "near":
   * the one offers what is wired in, the other what the question is about.
   */
  choices: MentionGroup[];
  resources: ReadonlyMap<AssetId, ResourceEntry>;
  issues: ReadonlyMap<AssetId, MediaState>;
  value: string;
  label: string;
  placeholder: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (next: string) => void;
  /** Losing focus, with the field's words as they stand. */
  onCommit: () => void;
  onSubmit: () => void;
  onDismiss: () => void;
  /**
   * The candidate list opened or closed.
   *
   * Said because the panel is kept inside the canvas by clamping against a
   * height it works out in advance: a list hanging off the field that nobody
   * told it about would hang off the canvas instead.
   */
  onOffer: (open: boolean) => void;
}) {
  const listId = useId();
  const [typed, setTyped] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [active, setActive] = useState(0);
  const [looked, setLooked] = useState<number | null>(null);

  const groups = useMemo(
    () => narrowMentions(choices, typed?.query ?? ""),
    [choices, typed],
  );
  const rows = useMemo<OfferRow[]>(() => {
    const out: OfferRow[] = [];
    for (const group of groups) {
      for (const choice of group.choices) {
        out.push({ label: group.label, index: out.length, choice });
      }
    }
    return out;
  }, [groups]);
  const offered = typed !== null;
  const chosen = rows.length === 0 ? 0 : active % rows.length;
  const spans = useMemo(() => mentionSpans(value), [value]);

  useEffect(() => {
    onOffer(typed !== null);
  }, [typed, onOffer]);

  /**
   * Takes up the offer again after the caret moved.
   *
   * The highlighted candidate is kept while the query is the one it was chosen
   * from: moving through a list with the arrow keys moves the caret nowhere, and
   * a field that forgot the selection at every key could not be driven by one.
   */
  const retake = (prompt: string, caret: number) => {
    const next = mentionBeingTyped(prompt, caret);
    if (next?.query !== typed?.query) setActive(0);
    setTyped(next);
  };

  const insert = (choice: MentionChoice) => {
    if (!typed) return;
    const area = inputRef.current;
    const caret = area?.selectionStart ?? value.length;
    const token = mentionToken(choice.node.id);
    // A space follows, so the next word is not written into the closing bracket.
    onChange(`${value.slice(0, typed.start)}${token} ${value.slice(caret)}`);
    const rest = typed.start + token.length + 1;
    setTyped(null);
    setActive(0);
    requestAnimationFrame(() => {
      if (!area) return;
      area.focus();
      area.setSelectionRange(rest, rest);
    });
  };

  /** Takes a mention out of the words, whole, however it was asked to. */
  const remove = (span: MentionSpan) => {
    onChange(value.slice(0, span.start) + value.slice(span.end));
    setLooked(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const area = event.currentTarget;
    const step = (move: number) => {
      event.preventDefault();
      const count = Math.max(1, rows.length);
      setActive((index) => (((index + move) % count) + count) % count);
    };
    if (offered) {
      if (event.key === "ArrowDown") return step(1);
      if (event.key === "ArrowUp") return step(-1);
      if (event.key === "Enter" || event.key === "Tab") {
        const row = rows[chosen];
        if (row) {
          event.preventDefault();
          insert(row.choice);
          return;
        }
      }
      // Escape closes the offer before it closes the panel: the offer is what
      // the key was pressed for, and losing the panel as well would be two
      // things undone by one.
      if (event.key === "Escape") {
        event.preventDefault();
        setTyped(null);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    // Backspace behind a mention takes the whole of it. One character at a time
    // would leave a bracket and half an id among the words, which reads as prose
    // and resolves as nothing.
    if (
      event.key === "Backspace" &&
      area.selectionStart === area.selectionEnd
    ) {
      const behind = mentionSpans(value).find(
        (span) => span.end === area.selectionStart,
      );
      if (behind) {
        event.preventDefault();
        remove(behind);
        requestAnimationFrame(() => {
          area.focus();
          area.setSelectionRange(behind.start, behind.start);
        });
      }
    }
  };

  return (
    <div className="mention-field">
      <textarea
        aria-activedescendant={
          offered && rows[chosen] ? `${listId}-${chosen}` : undefined
        }
        aria-controls={listId}
        aria-expanded={offered}
        aria-label={label}
        className="prompt-panel-input"
        onBlur={() => {
          setTyped(null);
          onCommit();
        }}
        onChange={(event) => {
          const { value: next, selectionStart } = event.target;
          onChange(next);
          retake(next, selectionStart ?? next.length);
        }}
        onClick={(event) =>
          retake(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onKeyDown={onKeyDown}
        onKeyUp={(event) =>
          retake(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        placeholder={placeholder}
        ref={inputRef}
        rows={3}
        value={value}
      />

      {offered && (
        <div
          aria-label="What this prompt may mention"
          className="mention-offer"
          id={listId}
          role="listbox"
        >
          {rows.length === 0 && (
            <p className="prompt-panel-note">
              Nothing on this canvas answers to that.
            </p>
          )}
          {rows.map((row, at) => (
            <div key={row.choice.node.id}>
              {row.label !== rows[at - 1]?.label && (
                <p className="mention-offer-label">{row.label}</p>
              )}
              <button
                aria-selected={row.index === chosen}
                className={row.index === chosen ? "is-active" : ""}
                id={`${listId}-${row.index}`}
                // Held here rather than left to the click: a field that lost
                // focus first would commit and look away before the choice
                // landed in it.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(row.choice)}
                role="option"
                type="button"
              >
                {row.choice.media?.url && (
                  <img
                    alt=""
                    className="mention-offer-thumb"
                    src={row.choice.media.url}
                  />
                )}
                <span className="mention-offer-name">
                  {row.choice.node.title}
                </span>
                <span className="mention-offer-summary">
                  {row.choice.summary}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}

      {spans.length > 0 && (
        <ul aria-label="What this prompt mentions" className="mention-chips">
          {spans.map((span, index) => {
            const mentioned = findNode(canvas, span.nodeId);
            const media = mentioned
              ? mediaInfoForNode(mentioned, resources, issues)
              : null;
            const name = mentioned?.title ?? "a node that is gone";
            return (
              <li
                className={mentioned ? "mention-chip" : "mention-chip is-gone"}
                key={`${span.start}:${span.nodeId}`}
                onBlur={() => setLooked(null)}
                onFocus={() => setLooked(index)}
                onMouseEnter={() => setLooked(index)}
                onMouseLeave={() => setLooked(null)}
              >
                {media?.url && (
                  <img alt="" className="mention-chip-thumb" src={media.url} />
                )}
                <span className="mention-chip-name">{name}</span>
                <button
                  aria-label={`Take ${name} out of the prompt`}
                  className="mention-chip-drop"
                  onClick={() => remove(span)}
                  type="button"
                >
                  ✕
                </button>
                {looked === index && mentioned && (
                  <MentionLook media={media} node={mentioned} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
