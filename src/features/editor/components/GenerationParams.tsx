import { useEffect, useState } from "react";
import type { GenerationPreferences } from "../../../api";
import {
  AUDIO_FORMATS,
  GENERATION_SHAPES,
  IMAGE_BACKGROUNDS,
  IMAGE_QUALITIES,
  MAX_AUDIO_SPEED,
  MAX_IMAGES_PER_RUN,
  MAX_VIDEO_SECONDS,
  MIN_AUDIO_SPEED,
  REASONING_EFFORTS,
  VIDEO_IMAGE_MODES,
  VIDEO_RESOLUTIONS,
  type Capability,
} from "../../../shared/domain";

/** What one parameter may carry. */
export type ParamValue = string | number | boolean;

/** What the two things a video can do with its pictures are called. */
const VIDEO_MODE_NAMES: Record<string, string> = {
  auto: "Frames",
  reference: "References",
};

interface Props {
  capability: Capability;
  params: Record<string, unknown>;
  /** What was set for every node, which one this node leaves out falls back to. */
  defaults: GenerationPreferences | null;
  /** Writing null takes a parameter back out, so the default speaks again. */
  onChange: (key: string, value: ParamValue | null) => void;
}

/**
 * The parameters one capability actually has, and no others.
 *
 * Each field says what the global default is on the choice that leaves the
 * parameter out, so it is visible which of the two is speaking: a node that
 * carries its own stops following a change made in settings, and a reader who
 * cannot see the difference cannot tell that has happened.
 *
 * What is typed is held until focus leaves the field, for the reason the prompt
 * is: a keystroke is not a choice, and writing one would make an undo entry and
 * a save of every letter.
 */
export function GenerationParams({
  capability,
  params,
  defaults,
  onChange,
}: Props) {
  if (capability === "image") {
    return (
      <div className="prompt-panel-params">
        <Choice
          fallback={defaults?.image.size}
          label="Shape"
          onChange={(value) => onChange("size", value)}
          options={GENERATION_SHAPES}
          value={word(params, "size")}
        />
        <Choice
          fallback={defaults?.image.quality}
          label="Quality"
          onChange={(value) => onChange("quality", value)}
          options={IMAGE_QUALITIES}
          value={word(params, "quality")}
        />
        <Choice
          fallback={defaults?.image.background}
          label="Background"
          onChange={(value) => onChange("background", value)}
          options={IMAGE_BACKGROUNDS}
          value={word(params, "background")}
        />
        <Amount
          fallback={defaults?.image.count}
          label="Images"
          max={MAX_IMAGES_PER_RUN}
          min={1}
          onChange={(value) => onChange("count", value)}
          step={1}
          value={figure(params, "count")}
        />
      </div>
    );
  }

  if (capability === "video") {
    return (
      <div className="prompt-panel-params">
        <Choice
          label="Shape"
          onChange={(value) => onChange("ratio", value)}
          options={GENERATION_SHAPES}
          value={word(params, "ratio")}
        />
        <Choice
          fallback={defaults?.video.resolution}
          label="Resolution"
          onChange={(value) => onChange("resolution", value)}
          options={VIDEO_RESOLUTIONS}
          value={word(params, "resolution")}
        />
        <Amount
          fallback={defaults?.video.seconds}
          label="Seconds"
          max={MAX_VIDEO_SECONDS}
          min={1}
          onChange={(value) => onChange("seconds", value)}
          step={1}
          value={figure(params, "seconds")}
        />
        <Choice
          fallback={defaults?.video.mode}
          label="Pictures are"
          names={VIDEO_MODE_NAMES}
          onChange={(value) => onChange("mode", value)}
          options={VIDEO_IMAGE_MODES}
          value={word(params, "mode")}
        />
        <Flag
          label="Generate audio"
          onChange={(value) => onChange("generateAudio", value)}
          value={
            yesNo(params, "generateAudio") ??
            defaults?.video.generateAudio ??
            true
          }
        />
        <Flag
          label="Watermark"
          onChange={(value) => onChange("watermark", value)}
          value={
            yesNo(params, "watermark") ?? defaults?.video.watermark ?? false
          }
        />
      </div>
    );
  }

  if (capability === "audio") {
    return (
      <div className="prompt-panel-params">
        <Words
          fallback={defaults?.audio.voice}
          label="Voice"
          onChange={(value) => onChange("voice", value)}
          placeholder="The voice the model knows"
          value={word(params, "voice")}
        />
        <Choice
          fallback={defaults?.audio.format}
          label="Format"
          onChange={(value) => onChange("format", value)}
          options={AUDIO_FORMATS}
          value={word(params, "format")}
        />
        <Amount
          fallback={defaults?.audio.speed}
          label="Speed"
          max={MAX_AUDIO_SPEED}
          min={MIN_AUDIO_SPEED}
          onChange={(value) => onChange("speed", value)}
          step={0.05}
          value={figure(params, "speed")}
        />
        <Flag
          label="File under Music"
          onChange={(value) => onChange("music", value)}
          value={yesNo(params, "music") ?? false}
        />
        <Words
          className="prompt-panel-wide"
          fallback={defaults?.audio.instructions}
          label="Direction"
          onChange={(value) => onChange("instructions", value)}
          placeholder="Spoken as directions to the voice"
          value={word(params, "instructions")}
        />
      </div>
    );
  }

  return (
    <div className="prompt-panel-params">
      <Amount
        label="Temperature"
        max={2}
        min={0}
        onChange={(value) => onChange("temperature", value)}
        step={0.1}
        value={figure(params, "temperature")}
      />
      <Amount
        label="Max tokens"
        min={1}
        onChange={(value) => onChange("maxTokens", value)}
        step={1}
        value={figure(params, "maxTokens")}
      />
      <Choice
        fallback={defaults?.reasoningEffort}
        label="Reasoning effort"
        onChange={(value) => onChange("reasoningEffort", value)}
        options={REASONING_EFFORTS}
        value={word(params, "reasoningEffort")}
      />
      <Words
        className="prompt-panel-wide"
        fallback={defaults?.systemPrompt}
        label="System prompt"
        onChange={(value) => onChange("instructions", value)}
        placeholder="Frames this node's answer"
        value={word(params, "instructions")}
      />
    </div>
  );
}

/** What a parameter carries, or null when the node leaves it to the default. */
function word(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function figure(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function yesNo(params: Record<string, unknown>, key: string): boolean | null {
  const value = params[key];
  return typeof value === "boolean" ? value : null;
}

/** What leaving a parameter out is called: the default, and what it is. */
function inherited(fallback: string | number | undefined): string {
  return fallback === undefined || `${fallback}`.trim() === ""
    ? "Default"
    : `Default · ${fallback}`;
}

interface ChoiceProps {
  label: string;
  value: string | null;
  options: readonly string[];
  fallback?: string;
  /** What the values are called, where the value itself is not a word for it. */
  names?: Record<string, string>;
  onChange: (value: string | null) => void;
}

function Choice({
  label,
  value,
  options,
  fallback,
  names,
  onChange,
}: ChoiceProps) {
  // A value set somewhere this list does not reach is still what will be sent,
  // so it is offered rather than shown as no choice at all.
  const kept = value !== null && !options.includes(value);
  return (
    <label className="dialog-field">
      <span>{label}</span>
      <select
        onChange={(event) =>
          onChange(event.target.value === "" ? null : event.target.value)
        }
        value={value ?? ""}
      >
        <option value="">{inherited(fallback)}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {names?.[option] ?? option}
          </option>
        ))}
        {kept && <option value={value ?? ""}>{value} (kept)</option>}
      </select>
    </label>
  );
}

interface AmountProps {
  label: string;
  value: number | null;
  min: number;
  max?: number;
  step?: number;
  fallback?: number;
  onChange: (value: number | null) => void;
}

function Amount({
  label,
  value,
  min,
  max,
  step,
  fallback,
  onChange,
}: AmountProps) {
  const [draft, setDraft] = useState(() => (value === null ? "" : `${value}`));

  useEffect(() => {
    setDraft(value === null ? "" : `${value}`);
  }, [value]);

  const commit = () => {
    const typed = draft.trim();
    if (typed === "") {
      if (value !== null) onChange(null);
      return;
    }
    const parsed = Number(typed);
    // A number the field cannot mean is given back as the one it had, rather
    // than written: a parameter nobody asked for would reach the provider.
    if (!Number.isFinite(parsed)) {
      setDraft(value === null ? "" : `${value}`);
      return;
    }
    // The bounds are the ones an ask is made within, so a number past them is
    // held to the nearest rather than passed on to be refused.
    const held = Math.min(Math.max(parsed, min), max ?? parsed);
    setDraft(`${held}`);
    if (held !== value) onChange(held);
  };

  return (
    <label className="dialog-field">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        placeholder={inherited(fallback)}
        step={step}
        type="number"
        value={draft}
      />
    </label>
  );
}

interface WordsProps {
  label: string;
  value: string | null;
  fallback?: string;
  placeholder?: string;
  className?: string;
  onChange: (value: string | null) => void;
}

function Words({
  label,
  value,
  fallback,
  placeholder,
  className,
  onChange,
}: WordsProps) {
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const commit = () => {
    const typed = draft.trim();
    if (typed === (value ?? "")) return;
    onChange(typed === "" ? null : typed);
  };

  return (
    <label className={`dialog-field ${className ?? ""}`.trim()}>
      <span>{label}</span>
      <input
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        placeholder={
          fallback && fallback.trim() !== ""
            ? `Default · ${fallback}`
            : placeholder
        }
        value={draft}
      />
    </label>
  );
}

/**
 * A yes-and-no, shown as the answer that will be sent.
 *
 * There is no third state to offer: a box that is either ticked or not cannot
 * say "whoever set the default decides", and showing the default's own answer is
 * the honest reading of what a run would do.
 */
function Flag({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="settings-check">
      <input
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}
