import {
  CAPABILITY_LABELS,
  MODEL_CAPABILITIES,
  type Capability,
} from "../../shared/domain";
import { coverageOf, type Coverage } from "./coverage";
import type { ChannelModel } from "../../api";

/**
 * What a set of models covers, per capability.
 *
 * A count of models does not answer the question anyone actually has — "can
 * this make a picture?" — so the four capabilities are named, with the ones
 * nothing serves shown as gaps rather than left out. A gap is the useful part:
 * it is what a node of that kind is going to refuse for.
 */
export function CoverageChips({ models }: { models: ChannelModel[] }) {
  const coverage: Coverage = coverageOf(models);
  return (
    <p aria-label="What this channel can generate" className="coverage-chips">
      {MODEL_CAPABILITIES.map((capability: Capability) => (
        <span
          className={
            coverage[capability] > 0 ? "coverage-chip" : "coverage-chip is-gap"
          }
          key={capability}
          title={
            coverage[capability] > 0
              ? `${coverage[capability]} ${CAPABILITY_LABELS[capability].toLowerCase()} model${
                  coverage[capability] === 1 ? "" : "s"
                }`
              : `No ${CAPABILITY_LABELS[capability].toLowerCase()} model, so no ${CAPABILITY_LABELS[capability].toLowerCase()} node can use this channel`
          }
        >
          {CAPABILITY_LABELS[capability]}
          {coverage[capability] > 0 && (
            <span className="coverage-count">{coverage[capability]}</span>
          )}
        </span>
      ))}
    </p>
  );
}
