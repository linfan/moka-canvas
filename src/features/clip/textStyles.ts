import { defaultTextStyle, type TextClipStyle } from "../../shared/domain";

/**
 * The four styles the Text page offers, as whole values.
 *
 * A preset fills the entire style — every field a text clip carries, font
 * included — so pressing one is a decision about the whole look rather than a
 * nudge to one axis. All four are combinations of fields the domain already
 * has, and Basic is the style a clip is born with, so the presets and the
 * factory can never drift apart.
 *
 * Pure data: nothing here touches a document.
 */

export type TextStylePresetId = "basic" | "title" | "lowerThird" | "caption";

export interface TextStylePreset {
  id: TextStylePresetId;
  /** What the picker calls the preset. */
  label: string;
  style: TextClipStyle;
}

export const TEXT_STYLE_PRESETS: readonly TextStylePreset[] = [
  { id: "basic", label: "Basic", style: defaultTextStyle() },
  {
    // A title: large, bold, and centred in the frame.
    id: "title",
    label: "Title",
    style: { ...defaultTextStyle(), fontSize: 96, bold: true },
  },
  {
    // A lower third: set left at the foot of the picture, on a plate so it
    // reads over anything.
    id: "lowerThird",
    label: "Lower third",
    style: {
      ...defaultTextStyle(),
      fontSize: 56,
      align: "left",
      position: "bottom",
      background: "#101010",
    },
  },
  {
    // A caption: white words at the foot of the picture, kept readable by a
    // black outline — the shape subtitles arrive in.
    id: "caption",
    label: "Caption",
    style: {
      ...defaultTextStyle(),
      fontSize: 48,
      position: "bottom",
      strokeWidth: 4,
      strokeColor: "#000000",
    },
  },
];

/** The preset with this id, or undefined for one the table never knew. */
export function presetById(id: string): TextStylePreset | undefined {
  return TEXT_STYLE_PRESETS.find((preset) => preset.id === id);
}

/** Whether two styles ask for the same look, field by field. */
export function sameStyle(a: TextClipStyle, b: TextClipStyle): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.align === b.align &&
    a.position === b.position &&
    a.background === b.background &&
    a.strokeWidth === b.strokeWidth &&
    a.strokeColor === b.strokeColor
  );
}
