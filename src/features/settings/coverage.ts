import type { ChannelModel, ChannelView } from "../../api";
import {
  CAPABILITY_LABELS,
  MODEL_CAPABILITIES,
  type Capability,
} from "../../shared/domain";

/** How many usable models a set of models has per capability. */
export type Coverage = Record<Capability, number>;

export function coverageOf(models: ChannelModel[]): Coverage {
  const coverage = Object.fromEntries(
    MODEL_CAPABILITIES.map((capability) => [capability, 0]),
  ) as Coverage;
  for (const model of models) {
    if (model.enabled) coverage[model.capability] += 1;
  }
  return coverage;
}

/**
 * The first capability with nothing serving it.
 *
 * What a new model row starts as: adding a model to a channel that already has
 * text is more often about the picture or the sound it cannot make yet, and a
 * row that always begins as "Text" is how a channel ends up with six text
 * models and no way to make an image.
 */
export function firstMissing(coverage: Coverage): Capability {
  return (
    MODEL_CAPABILITIES.find((capability) => coverage[capability] === 0) ??
    "text"
  );
}

/** The capabilities that have models, in the standing order. */
export function covered(coverage: Coverage): Capability[] {
  return MODEL_CAPABILITIES.filter((capability) => coverage[capability] > 0);
}

/** The capabilities nothing serves yet. */
export function missing(coverage: Coverage): Capability[] {
  return MODEL_CAPABILITIES.filter((capability) => coverage[capability] === 0);
}

export function coverageLabel(capability: Capability): string {
  return CAPABILITY_LABELS[capability];
}

/**
 * What a channel can actually do, which is the question behind "3 models":
 * three text models answer nothing about whether it can make a picture.
 */
export function coverageOfChannel(channel: ChannelView): Coverage {
  return coverageOf(channel.models);
}
