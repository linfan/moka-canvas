import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  AssetId,
  CanvasDocument,
  ResourceEntry,
} from "../../../shared/domain";
import { findNode, mentionSpans } from "../../../shared/domain";
import { mediaInfoForNode, type MediaState } from "../canvas/mediaCards";
import {
  mentionBeingTyped,
  mentionToken,
  narrowMentions,
  type MentionChoice,
  type MentionGroup,
} from "../canvas/mentions";
import { MentionPreview } from "./MentionPreview";

/** What a chip is found by, and what carries the node it points at. */
const CHIP_SELECTOR = "[data-node-id]";

/**
 * The words of a field as one string.
 *
 * A chip stands for the whole of its token, a `<br>` for the line it breaks,
 * and a block that holds nothing for the line it is without counting the
 * `<br>` the field drew inside it to keep the line visible — a newline and
 * its placeholder are one newline, not two.
 */
function serialize(root: Node): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const nodeId = el.dataset?.nodeId;
    if (nodeId !== undefined) {
      out += mentionToken(nodeId);
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    if (el.tagName === "DIV" || el.tagName === "P") {
      if (out !== "" && !out.endsWith("\n")) out += "\n";
      if (el.textContent === "" && !el.querySelector(CHIP_SELECTOR)) return;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return out;
}

/**
 * Where the caret sits in the field's words, counting a chip as the token it
 * stands for — or null when the caret is not in this field to be counted.
 *
 * Taken by cloning what lies before the caret and reading it, so one walk of
 * the field means the same thing here as it does when the words are taken out.
 */
function caretOffset(area: HTMLElement): number | null {
  const selection = area.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.startContainer !== area && !area.contains(range.startContainer)) {
    return null;
  }
  try {
    const before = range.cloneRange();
    before.selectNodeContents(area);
    before.setEnd(range.startContainer, range.startOffset);
    return serialize(before.cloneContents()).length;
  } catch {
    return null;
  }
}

/** Stands the caret at a place in the words, counting chips as their tokens. */
function placeCaret(area: HTMLElement, target: number): void {
  const selection = area.ownerDocument.getSelection?.();
  if (!selection) return;
  let seen = 0;
  let lastChar = "";
  let hit: { node: Node; offset: number } | null = null;
  const walkChildren = (parent: Node) => {
    const kids = Array.from(parent.childNodes);
    for (let index = 0; index < kids.length; index += 1) {
      if (hit) return;
      const node = kids[index];
      if (node.nodeType === Node.TEXT_NODE) {
        const words = node.nodeValue ?? "";
        if (target <= seen + words.length) {
          hit = { node, offset: Math.max(0, target - seen) };
          return;
        }
        seen += words.length;
        lastChar = words.slice(-1) || lastChar;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const nodeId = el.dataset?.nodeId;
        if (nodeId !== undefined) {
          const length = mentionToken(nodeId).length;
          if (target <= seen) {
            hit = { node: parent, offset: index };
            return;
          }
          if (target <= seen + length) {
            hit = { node: parent, offset: index + 1 };
            return;
          }
          seen += length;
          lastChar = "]";
        } else if (el.tagName === "BR") {
          if (target <= seen) {
            hit = { node: parent, offset: index };
            return;
          }
          seen += 1;
          lastChar = "\n";
          if (target <= seen) {
            hit = { node: parent, offset: index + 1 };
            return;
          }
        } else {
          if (
            (el.tagName === "DIV" || el.tagName === "P") &&
            seen > 0 &&
            lastChar !== "\n"
          ) {
            seen += 1;
            lastChar = "\n";
            if (target <= seen) {
              hit = { node: el, offset: 0 };
              return;
            }
          }
          walkChildren(el);
        }
      }
    }
  };
  walkChildren(area);
  if (!hit) hit = { node: area, offset: area.childNodes.length };
  const range = area.ownerDocument.createRange();
  range.setStart(hit.node, hit.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Puts the keyboard in the field and the caret at the end of its words. */
export function focusEnd(area: HTMLElement): void {
  area.focus();
  placeCaret(area, serialize(area).length);
}

/**
 * A mention drawn: the name of the card it points at, written the way a
 * sentence writes a reference — between ticks, so `` `Plate` `` reads as a
 * card being named rather than as another word in the line.
 */
function chipFor(
  document: Document,
  canvas: CanvasDocument,
  nodeId: string,
): HTMLElement {
  const mentioned = findNode(canvas, nodeId);
  const chip = document.createElement("span");
  chip.className = mentioned ? "mention-chip" : "mention-chip is-gone";
  chip.contentEditable = "false";
  chip.dataset.nodeId = nodeId;
  chip.dataset.kind = mentioned?.kind ?? "gone";
  chip.title = mentioned?.title ?? "A node that is gone";
  const name = document.createElement("span");
  name.className = "mention-chip-name";
  name.textContent = mentioned?.title ?? nodeId;
  chip.append(tick(document, "`"), name, tick(document, "`"));
  return chip;
}

/** One of the two marks a chip is wrapped in. Decoration, not words. */
function tick(document: Document, mark: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "mention-chip-tick";
  span.setAttribute("aria-hidden", "true");
  span.textContent = mark;
  return span;
}

/**
 * Draws the words into the field: prose as prose, and every mention as the
 * chip that stands for it. The field is taken apart and put back together
 * rather than patched, since a patch that missed would leave a token among
 * the words where a chip belongs.
 */
function renderValue(
  area: HTMLElement,
  value: string,
  canvas: CanvasDocument,
): void {
  const document = area.ownerDocument;
  const kids: Node[] = [];
  let cursor = 0;
  for (const span of mentionSpans(value)) {
    if (span.start > cursor) {
      kids.push(document.createTextNode(value.slice(cursor, span.start)));
    }
    kids.push(chipFor(document, canvas, span.nodeId));
    cursor = span.end;
  }
  if (cursor < value.length) {
    kids.push(document.createTextNode(value.slice(cursor)));
  }
  area.replaceChildren(...kids);
}

/**
 * Where the offer hangs from, in the wrapper's own coordinates: the point the
 * caret is drawn at, or null when the caret keeps no point to be found.
 */
function caretPoint(wrap: HTMLElement): { left: number; top: number } | null {
  const selection = wrap.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  let rect: DOMRect | null = null;
  if (typeof range.getBoundingClientRect === "function") {
    const found = range.getBoundingClientRect();
    if (found && (found.height > 0 || found.top > 0)) rect = found;
  }
  if (!rect && typeof range.getClientRects === "function") {
    const rects = range.getClientRects();
    if (rects.length > 0) rect = rects[0];
  }
  if (!rect) return null;
  const wrapRect = wrap.getBoundingClientRect();
  return {
    left: rect.left - wrapRect.left,
    top: rect.bottom - wrapRect.top + 2,
  };
}

/** The size a dragged field is held within, so it stays a field. */
const FIELD_MIN_WIDTH = 220;
const FIELD_MIN_HEIGHT = 60;

/** A candidate row, carrying the place it holds in the keyboard's own list. */
interface OfferRow {
  label: string;
  index: number;
  choice: MentionChoice;
}

/**
 * The prompt field, which knows that a mention points at another card rather
 * than being prose, and draws one as the name of that card between ticks —
 * the way a sentence written in Markdown refers to something.
 *
 * A rich field rather than a textarea with the tokens shown among the words:
 * a token is forty-four characters across and the name it stands for is not,
 * so the words themselves would spend more room naming a card than the card
 * ever would. The chip is one thing the caret walks over and the backspace
 * takes out whole, and hovering it summons what it points at — the picture,
 * the file to listen to, or the words it holds.
 *
 * What reaches the document is still the token, which is what the resolver
 * reads; the chips are only how the field shows one.
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
  fieldSize = null,
  offerAtCaret = false,
  onChange,
  onCommit,
  onFieldResize,
  onSubmit,
  onDismiss,
  onOffer,
  under,
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
  inputRef: React.RefObject<HTMLDivElement | null>;
  /** The size the reader dragged the field to, or null for its own default. */
  fieldSize?: { width: number; height: number } | null;
  /**
   * Whether the offer hangs from the @ itself rather than from an edge of the
   * field. Asked for by a panel whose field stands alone on the canvas, where
   * an offer at the foot of a tall field is easy to miss; a panel that keeps
   * its field at the foot of a column leaves the offer where the CSS puts it.
   */
  offerAtCaret?: boolean;
  onChange: (next: string) => void;
  /** Losing focus, with the field's words as they stand. */
  onCommit: () => void;
  /** The reader dragged the field's corner, which the panel grows with. */
  onFieldResize?: (size: { width: number; height: number }) => void;
  onSubmit: () => void;
  onDismiss: () => void;
  /**
   * What stands under the field, inside the same box: what the words point at,
   * or whatever else belongs with them. Part of the field rather than the
   * column after it, because the field is the thing that grows with the panel.
   */
  under?: React.ReactNode;
  /**
   * The candidate list opened or closed.
   *
   * Said for whoever owns the field and needs to know that a list is hanging
   * off it; a panel anchored to its node has no use for it and says nothing.
   */
  onOffer: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [active, setActive] = useState(0);
  /** The chip the pointer is resting on, and where to summon its card. */
  const [hovered, setHovered] = useState<{
    nodeId: string;
    left: number;
    top: number;
  } | null>(null);
  /** Where the @ being typed sits, which is where the offer hangs from. */
  const [caret, setCaret] = useState<{ left: number; top: number } | null>(
    null,
  );
  /** What the field was last given or said, so its own edits are not redrawn. */
  const drawn = useRef<{ value: string; canvas: CanvasDocument } | null>(null);

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

  useEffect(() => {
    onOffer(typed !== null);
  }, [typed, onOffer]);

  /**
   * Draws the field to match what it was given, when what it was given is not
   * what it last drew. Its own edits are left alone: redrawing a field that is
   * being typed in would take the caret away from where the words put it.
   */
  useLayoutEffect(() => {
    const area = inputRef.current;
    if (!area) return;
    const last = drawn.current;
    if (last && last.value === value && last.canvas === canvas) return;
    drawn.current = { value, canvas };
    const at = area.contains(area.ownerDocument.activeElement)
      ? caretOffset(area)
      : null;
    renderValue(area, value, canvas);
    if (at !== null) placeCaret(area, Math.min(at, value.length));
  }, [value, canvas, inputRef]);

  /**
   * Takes up the offer again after the caret moved.
   *
   * The highlighted candidate is kept while the query is the one it was chosen
   * from: moving through a list with the arrow keys moves the caret nowhere, and
   * a field that forgot the selection at every key could not be driven by one.
   */
  const retake = (prompt: string, caretAt: number) => {
    const next = mentionBeingTyped(prompt, caretAt);
    if (next?.query !== typed?.query) setActive(0);
    setTyped(next);
    // Hung from the @ itself rather than from the foot of the field: an offer
    // that appears where the point of the sentence is cannot be missed, and
    // one at the other end of a tall field can.
    const wrap = wrapRef.current;
    setCaret(next && offerAtCaret && wrap ? caretPoint(wrap) : null);
  };

  /** Reads the field after an edit of its own and says what changed. */
  const sync = () => {
    const area = inputRef.current;
    if (!area) return;
    const next = serialize(area);
    if (next !== drawn.current?.value) {
      drawn.current = { value: next, canvas };
      onChange(next);
    }
    retake(next, caretOffset(area) ?? next.length);
  };

  /**
   * Reads the field after the reader edited it.
   *
   * A token that arrived as words — pasted, say — is drawn as the chip it is,
   * so the field never shows a bracket where a card is meant.
   */
  const emit = () => {
    const area = inputRef.current;
    if (!area) return;
    const next = serialize(area);
    const chips = area.querySelectorAll(CHIP_SELECTOR).length;
    if (mentionSpans(next).length !== chips) {
      const at = caretOffset(area) ?? next.length;
      renderValue(area, next, canvas);
      placeCaret(area, at);
    }
    sync();
  };

  const insert = (choice: MentionChoice) => {
    if (!typed) return;
    const area = inputRef.current;
    const at = area ? (caretOffset(area) ?? value.length) : value.length;
    const token = mentionToken(choice.node.id);
    // A space follows, so the next word is not written into the chip.
    const next = `${value.slice(0, typed.start)}${token} ${value.slice(at)}`;
    setTyped(null);
    setActive(0);
    setCaret(null);
    drawn.current = { value: next, canvas };
    onChange(next);
    if (area) {
      renderValue(area, next, canvas);
      area.focus();
      placeCaret(area, typed.start + token.length + 1);
    }
  };

  /**
   * Takes the field's corner and drags it.
   *
   * The size is handed up rather than held here: the panel is as wide as the
   * field asks it to be, and only the panel knows what else has to move along.
   */
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const area = inputRef.current;
    if (!area || !onFieldResize) return;
    event.preventDefault();
    const start = {
      x: event.clientX,
      y: event.clientY,
      width: area.offsetWidth,
      height: area.offsetHeight,
    };
    const move = (moved: PointerEvent) => {
      onFieldResize({
        width: Math.max(FIELD_MIN_WIDTH, start.width + moved.clientX - start.x),
        height: Math.max(
          FIELD_MIN_HEIGHT,
          start.height + moved.clientY - start.y,
        ),
      });
    };
    const letGo = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", letGo);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", letGo);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const area = event.currentTarget;
    const composing = event.nativeEvent.isComposing;
    const step = (move: number) => {
      event.preventDefault();
      const count = Math.max(1, rows.length);
      setActive((index) => (((index + move) % count) + count) % count);
    };
    if (offered) {
      if (event.key === "ArrowDown") return step(1);
      if (event.key === "ArrowUp") return step(-1);
      if ((event.key === "Enter" || event.key === "Tab") && !composing) {
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
        setCaret(null);
        return;
      }
    }
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !composing
    ) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    // Backspace behind a chip takes the whole of it. One character at a time
    // is not a thing a chip can lose, but a field left to the browser could
    // ask for the key twice, and a reader should not have to press twice for
    // one thing undone.
    if (event.key === "Backspace") {
      const at = caretOffset(area);
      if (at === null) return;
      const spans = mentionSpans(value);
      const index = spans.findIndex((span) => span.end === at);
      if (index < 0) return;
      event.preventDefault();
      const chip = area.querySelectorAll(CHIP_SELECTOR)[index];
      if (chip) chip.remove();
      placeCaret(area, spans[index].start);
      sync();
    }
  };

  /** Words are taken in as words: a paste never brings another field's shapes. */
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const area = event.currentTarget;
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    const document = area.ownerDocument;
    const selection = document.getSelection?.();
    const range =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (range && area.contains(range.startContainer)) {
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      area.appendChild(document.createTextNode(text));
      placeCaret(area, serialize(area).length);
    }
    emit();
  };

  /** The pointer came onto something: a chip summons its card, prose takes it away. */
  const onHover = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const chip = target.closest?.(CHIP_SELECTOR) as HTMLElement | null;
    if (!chip) {
      setHovered(null);
      return;
    }
    const nodeId = chip.dataset.nodeId ?? "";
    if (nodeId === hovered?.nodeId) return;
    const wrap = wrapRef.current;
    const chipRect = chip.getBoundingClientRect();
    const wrapRect = wrap?.getBoundingClientRect();
    const left = chipRect.left - (wrapRect?.left ?? 0);
    const room = wrap?.clientWidth ?? 0;
    setHovered({
      nodeId,
      left:
        room > 0 ? Math.max(0, Math.min(left, room - 248)) : Math.max(0, left),
      top: chipRect.bottom - (wrapRect?.top ?? 0) + 6,
    });
  };

  const looked = hovered ? findNode(canvas, hovered.nodeId) : null;
  const lookedMedia = looked
    ? mediaInfoForNode(looked, resources, issues)
    : null;

  return (
    <div
      className="mention-field"
      onMouseLeave={() => setHovered(null)}
      ref={wrapRef}
    >
      <div className="mention-field-area">
        <div
          aria-activedescendant={
            offered && rows[chosen] ? `${listId}-${chosen}` : undefined
          }
          aria-controls={listId}
          aria-expanded={offered}
          aria-label={label}
          aria-multiline="true"
          className={
            value === ""
              ? "prompt-panel-input mention-input is-empty"
              : "prompt-panel-input mention-input"
          }
          contentEditable
          data-placeholder={placeholder}
          onBlur={() => {
            setTyped(null);
            setCaret(null);
            setHovered(null);
            onCommit();
          }}
          onClick={(event) => {
            const words = serialize(event.currentTarget);
            retake(words, caretOffset(event.currentTarget) ?? words.length);
          }}
          onInput={emit}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            const words = serialize(event.currentTarget);
            retake(words, caretOffset(event.currentTarget) ?? words.length);
          }}
          onMouseOver={onHover}
          onPaste={onPaste}
          ref={inputRef}
          role="textbox"
          style={
            fieldSize
              ? {
                  height: `${fieldSize.height}px`,
                  width: `${fieldSize.width}px`,
                }
              : undefined
          }
          suppressContentEditableWarning
        />
        {onFieldResize && (
          <div
            aria-hidden="true"
            className="mention-field-grip"
            onPointerDown={resize}
            title={t("editor:mention.fieldGrip")}
          />
        )}
      </div>

      {under}

      {hovered && (
        <div
          className="mention-look"
          data-testid="mention-look"
          style={{ left: `${hovered.left}px`, top: `${hovered.top}px` }}
        >
          {looked ? (
            <MentionPreview media={lookedMedia} node={looked} />
          ) : (
            <p className="mention-look-label">{t("editor:mention.gone")}</p>
          )}
        </div>
      )}

      {offered && (
        <div
          aria-label={t("editor:mention.mayMention")}
          className="mention-offer"
          id={listId}
          role="listbox"
          style={
            caret
              ? {
                  bottom: "auto",
                  // Kept off the field's right edge, where it would hang over
                  // the panel and read as belonging to the canvas instead.
                  left: `${Math.max(
                    0,
                    Math.min(
                      caret.left,
                      Math.max(
                        0,
                        (wrapRef.current?.clientWidth ?? caret.left + 180) -
                          180,
                      ),
                    ),
                  )}px`,
                  top: `${caret.top}px`,
                }
              : undefined
          }
        >
          {rows.length === 0 && (
            <p className="prompt-panel-note">{t("editor:mention.noAnswer")}</p>
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
    </div>
  );
}
