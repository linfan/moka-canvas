import { useMemo, useState } from "react";
import type { ModelCandidate } from "../../api";
import {
  CAPABILITY_LABELS,
  MODEL_CAPABILITIES,
  type Capability,
} from "../../shared/domain";

/**
 * How many candidates one capability shows before it asks for a narrower
 * search. A provider lists every model it has ever had, and three hundred rows
 * is not a choice anybody can make.
 */
const SHOWN_PER_GROUP = 30;

/**
 * What a provider says it offers, as suggestions.
 *
 * Grouped by the capability each identifier was guessed to serve, because the
 * decision being made is "which of these can make a picture" rather than
 * "which of these do I recognise". Anything the guess could not place is text,
 * which is what it becomes on the row too, and the group says so.
 */
export function CandidateList({
  candidates,
  added,
  disabled,
  onAdopt,
}: {
  candidates: ModelCandidate[];
  /** Identifiers already on the form, so adopting one twice is not offered. */
  added: Set<string>;
  disabled: boolean;
  onAdopt: (ids: string[], capability: Capability) => void;
}) {
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = candidates.filter(
      (candidate) =>
        needle === "" || candidate.id.toLowerCase().includes(needle),
    );
    return MODEL_CAPABILITIES.map((capability) => ({
      capability,
      items: matching.filter(
        (candidate) => (candidate.capability ?? "text") === capability,
      ),
      // A whole group that was placed by guessing says so: the guess is a
      // starting point, and text is where an unplaceable name lands.
      guessed: matching.filter(
        (candidate) => candidate.capability === null && capability === "text",
      ).length,
    })).filter((group) => group.items.length > 0);
  }, [candidates, filter]);

  const shown = groups.reduce((total, group) => total + group.items.length, 0);

  return (
    <div className="candidate-picker">
      <input
        aria-label="Filter the models the provider offers"
        onChange={(event) => setFilter(event.target.value)}
        placeholder={`Filter ${candidates.length} offered`}
        type="search"
        value={filter}
      />

      {shown === 0 ? (
        <p className="settings-hint">
          Nothing offered matches “{filter.trim()}”.
        </p>
      ) : (
        groups.map((group) => {
          const label = CAPABILITY_LABELS[group.capability];
          const fresh = group.items.filter(
            (candidate) => !added.has(candidate.id),
          );
          const hidden = Math.max(0, group.items.length - SHOWN_PER_GROUP);
          return (
            <section
              aria-label={`${label} models offered`}
              className="settings-section"
              key={group.capability}
            >
              <h4 className="settings-heading">
                <span>
                  {label}
                  <span className="settings-hint">
                    {group.items.length} offered
                    {group.guessed === group.items.length && group.guessed > 0
                      ? " — placed by guessing from the name"
                      : ""}
                  </span>
                </span>
                <button
                  aria-label={`Add all ${label.toLowerCase()} models offered`}
                  disabled={disabled || fresh.length === 0}
                  onClick={() =>
                    onAdopt(
                      fresh.map((candidate) => candidate.id),
                      group.capability,
                    )
                  }
                  title={
                    fresh.length === 0
                      ? `Every ${label.toLowerCase()} model offered is already on the form`
                      : `Add ${fresh.length === 1 ? "the one" : `all ${fresh.length}`} ${label.toLowerCase()} model${
                          fresh.length === 1 ? "" : "s"
                        } offered to the form`
                  }
                  type="button"
                >
                  Add all
                </button>
              </h4>

              <ul className="model-list">
                {group.items.slice(0, SHOWN_PER_GROUP).map((candidate) => (
                  <li className="model-row" key={candidate.id}>
                    <span className="candidate-id">{candidate.id}</span>
                    {added.has(candidate.id) ? (
                      <span className="channel-tag">on the form</span>
                    ) : (
                      <button
                        aria-label={`Add ${candidate.id} to the ${label.toLowerCase()} models`}
                        disabled={disabled}
                        onClick={() =>
                          onAdopt([candidate.id], group.capability)
                        }
                        type="button"
                      >
                        Add
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {hidden > 0 && (
                <p className="settings-hint">
                  {hidden} more {label.toLowerCase()} model
                  {hidden === 1 ? "" : "s"} offered — narrow the filter to see
                  them.
                </p>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
