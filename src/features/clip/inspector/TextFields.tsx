import { useEffect, useRef, useState } from "react";
import {
  MAX_TIMELINE_TEXT_CONTENT,
  type TextClipData,
  type TextClipStyle,
} from "../../../shared/domain";
import { CLIP_FONTS } from "../fonts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  STROKE_WIDTH_MAX,
  clampTextContent,
} from "../interactions/textActions";
import { wholeNumberIn } from "./clipFieldMath";

/**
 * The form a text clip wears, wherever one is written.
 *
 * The same fields set the words that are about to be laid down on the Text
 * page and the words a chosen clip already carries, so the two can never grow
 * apart: the composer and the inspector both hand this form a value and take
 * the value it makes back. Nothing is committed here — the caller decides what
 * a keystroke, a release and a click each mean — except the points the form
 * can only know itself: the words commit on blur, `Escape` inside them asks
 * the caller to put back what was there, and a number commits on blur or on a
 * step button.
 *
 * A field a set of clips disagrees about wears `Mixed`: the caller says which
 * ones those are, and a mixed select or number shows the word rather than one
 * of the values, since there is no one value to show.
 */

/** Text held locally while a field is being typed in, synced when it is not. */
function useTypedText(value: string) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return { text, setText, focused };
}

/** The word a field wears when the chosen clips do not agree about it. */
function Mixed() {
  return <em className="clip-text-mixed">Mixed</em>;
}

function Label({ children, mixed }: { children: string; mixed?: boolean }) {
  return (
    <span className="clip-text-label">
      {children}
      {mixed === true && <Mixed />}
    </span>
  );
}

/** A whole-number field with a step down and a step up beside it. */
function NumberStepper({
  label,
  max,
  min,
  mixed,
  onCommit,
  value,
}: {
  label: string;
  min: number;
  max: number;
  /** The number the field stands for; null on a set that disagrees. */
  value: number | null;
  mixed: boolean;
  onCommit: (value: number) => void;
}) {
  const shown = mixed || value === null ? "" : String(value);
  const { text, setText, focused } = useTypedText(shown);
  const commit = () => {
    if (text.trim().length === 0) {
      setText(shown);
      return;
    }
    const parsed = wholeNumberIn(text, min, max);
    if (parsed === null) {
      // A reading outside the bounds is shown as it was rather than jumping
      // the number somewhere the reader did not ask for.
      setText(shown);
      return;
    }
    if (value !== null && parsed === value) return;
    onCommit(parsed);
  };
  const nudge = (delta: number) => {
    const from = value ?? Math.round((min + max) / 2);
    const next = Math.min(max, Math.max(min, from + delta));
    if (value !== null && next === value) return;
    onCommit(next);
  };
  const name = label.toLowerCase();
  return (
    <div className="clip-text-field clip-text-size">
      <Label mixed={mixed}>{label}</Label>
      <span className="clip-text-stepper">
        <button
          aria-label={`Smaller ${name}`}
          onClick={() => nudge(-1)}
          type="button"
        >
          −
        </button>
        <input
          aria-label={label}
          inputMode="numeric"
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => {
            focused.current = true;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder={mixed ? "Mixed" : undefined}
          value={text}
        />
        <button
          aria-label={`Larger ${name}`}
          onClick={() => nudge(1)}
          type="button"
        >
          +
        </button>
      </span>
    </div>
  );
}

export interface TextFieldsProps {
  /** The text the form is editing: a clip's own, or a draft standing in for it. */
  value: TextClipData;
  /**
   * The value the form makes. `commit` is false while a keystroke or a drag is
   * still going on and true at the point the caller should write it down.
   */
  onChange: (next: TextClipData, commit: boolean) => void;
  /** Style fields the chosen set disagrees about; those read as `Mixed`. */
  mixed?: ReadonlySet<keyof TextClipStyle>;
  /** Whether the words themselves may be edited here (one clip chosen). */
  words?: boolean;
  /** `Escape` in the words box: the caller puts back what the document holds. */
  onEscape?: () => void;
}

export function TextFields({
  value,
  onChange,
  mixed,
  words = true,
  onEscape,
}: TextFieldsProps) {
  const style = value.style;
  const isMixed = (key: keyof TextClipStyle): boolean =>
    mixed?.has(key) === true;
  const setStyle = (patch: Partial<TextClipStyle>, commit: boolean): void =>
    onChange({ content: value.content, style: { ...style, ...patch } }, commit);

  return (
    <div className="clip-text-fields" data-testid="clip-text-fields">
      {words ? (
        <label className="clip-text-field">
          <span className="clip-text-label">Content</span>
          <textarea
            aria-label="Content"
            data-testid="clip-text-content"
            maxLength={MAX_TIMELINE_TEXT_CONTENT}
            onBlur={() => onChange(value, true)}
            onChange={(event) => {
              const content = clampTextContent(event.target.value);
              onChange({ content, style }, false);
            }}
            onKeyDown={(event) => {
              // Enter is a newline inside the box, which is a break the author
              // asked for; Escape is the way back to what the document holds.
              if (event.key === "Escape") {
                event.preventDefault();
                onEscape?.();
              }
            }}
            rows={3}
            value={value.content}
          />
          <span className="clip-text-count">
            {value.content.length}/{MAX_TIMELINE_TEXT_CONTENT}
          </span>
        </label>
      ) : (
        <p className="clip-text-hint">
          Select one text clip to edit its words.
        </p>
      )}

      <div className="clip-text-row">
        <label className="clip-text-field clip-text-grow">
          <Label mixed={isMixed("fontFamily")}>Font</Label>
          <select
            aria-label="Font"
            onChange={(event) =>
              setStyle({ fontFamily: event.target.value }, true)
            }
            value={isMixed("fontFamily") ? "" : style.fontFamily}
          >
            {isMixed("fontFamily") && <option value="">Mixed</option>}
            {CLIP_FONTS.map((font) => (
              <option key={font.label} value={font.stack}>
                {font.label}
              </option>
            ))}
          </select>
        </label>
        <NumberStepper
          label="Size"
          max={FONT_SIZE_MAX}
          min={FONT_SIZE_MIN}
          mixed={isMixed("fontSize")}
          onCommit={(size) => setStyle({ fontSize: size }, true)}
          value={isMixed("fontSize") ? null : style.fontSize}
        />
      </div>

      <div className="clip-text-row">
        <label className="clip-text-field">
          <Label mixed={isMixed("color")}>Color</Label>
          <input
            aria-label="Color"
            onChange={(event) => setStyle({ color: event.target.value }, true)}
            type="color"
            value={style.color}
          />
        </label>
        <label className="clip-text-field">
          <Label mixed={isMixed("strokeColor")}>Stroke</Label>
          <input
            aria-label="Stroke color"
            onChange={(event) =>
              setStyle({ strokeColor: event.target.value }, true)
            }
            type="color"
            value={style.strokeColor}
          />
        </label>
        <NumberStepper
          label="Stroke width"
          max={STROKE_WIDTH_MAX}
          min={0}
          mixed={isMixed("strokeWidth")}
          onCommit={(width) => setStyle({ strokeWidth: width }, true)}
          value={isMixed("strokeWidth") ? null : style.strokeWidth}
        />
        <div className="clip-text-toggles">
          <button
            aria-label="Bold"
            aria-pressed={isMixed("bold") ? false : style.bold}
            className={
              isMixed("bold") || !style.bold
                ? "clip-text-toggle"
                : "clip-text-toggle is-on"
            }
            onClick={() => setStyle({ bold: !style.bold }, true)}
            type="button"
          >
            B
          </button>
          <button
            aria-label="Italic"
            aria-pressed={isMixed("italic") ? false : style.italic}
            className={
              isMixed("italic") || !style.italic
                ? "clip-text-toggle"
                : "clip-text-toggle is-on"
            }
            onClick={() => setStyle({ italic: !style.italic }, true)}
            type="button"
          >
            I
          </button>
        </div>
      </div>

      <div className="clip-text-row">
        <div className="clip-text-group">
          <Label mixed={isMixed("align")}>Align</Label>
          <div className="clip-text-toggles">
            {(["left", "center", "right"] as const).map((align) => (
              <button
                aria-label={`Align ${align}`}
                aria-pressed={isMixed("align") ? false : style.align === align}
                className={
                  isMixed("align") || style.align !== align
                    ? "clip-text-toggle"
                    : "clip-text-toggle is-on"
                }
                key={align}
                onClick={() => setStyle({ align }, true)}
                type="button"
              >
                {align === "left"
                  ? "Left"
                  : align === "center"
                    ? "Center"
                    : "Right"}
              </button>
            ))}
          </div>
        </div>
        <div className="clip-text-group">
          <Label mixed={isMixed("position")}>Position</Label>
          <div className="clip-text-toggles">
            {(["top", "center", "bottom"] as const).map((position) => (
              <button
                aria-label={`Position ${position}`}
                aria-pressed={
                  isMixed("position") ? false : style.position === position
                }
                className={
                  isMixed("position") || style.position !== position
                    ? "clip-text-toggle"
                    : "clip-text-toggle is-on"
                }
                key={position}
                onClick={() => setStyle({ position }, true)}
                type="button"
              >
                {position === "top"
                  ? "Top"
                  : position === "center"
                    ? "Center"
                    : "Bottom"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="clip-text-row">
        <div className="clip-text-group">
          <Label mixed={isMixed("background")}>Plate</Label>
          <div className="clip-text-toggles">
            <input
              aria-label="Plate color"
              onChange={(event) =>
                setStyle({ background: event.target.value }, true)
              }
              type="color"
              value={style.background ?? "#000000"}
            />
            <button
              aria-label="No plate"
              aria-pressed={style.background === null}
              className={
                style.background === null
                  ? "clip-text-toggle is-on"
                  : "clip-text-toggle"
              }
              onClick={() => setStyle({ background: null }, true)}
              type="button"
            >
              None
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
