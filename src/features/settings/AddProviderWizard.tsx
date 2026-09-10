import { useState } from "react";
import {
  providersApi,
  type ChannelDraft,
  type ChannelModel,
  type DefaultsPatch,
  type Inspection,
} from "../../api";
import {
  CAPABILITY_LABELS,
  MODEL_CAPABILITIES,
  PROVIDER_PROTOCOLS,
  type Capability,
  type ProviderProtocol,
} from "../../shared/domain";
import { CandidateList } from "./CandidateList";
import { coverageOf, firstMissing, missing } from "./coverage";
import { CoverageChips } from "./CoverageChips";
import { newRow, type ModelRow } from "./modelRow";
import { ModelRows } from "./ModelRows";
import { modelReference, useProviderStore } from "./providerStore";

/** Where the wizard is: an address, the models it offers, or the defaults. */
type Step = "address" | "models" | "defaults";

/**
 * Letting the server derive the protocol from the address, which is what it
 * does for an import. A literal so that choosing it narrows the rest away.
 */
const AUTO = "auto";
type ProtocolChoice = ProviderProtocol | typeof AUTO;

/** What each step is called, so the three are visible as one path. */
const STEP_LABELS: Record<Step, string> = {
  address: "Address and key",
  models: "What it can make",
  defaults: "What nodes reach for",
};

/**
 * Adding a provider, in the order the questions actually arise.
 *
 * The alternative was a form that stored a channel and then left the models,
 * their kinds and the defaults to be found in three other places, so the first
 * run failed for a reason nobody had been shown. Here an address and a key are
 * asked what they offer before anything is stored: a wrong one costs a message
 * rather than a channel to delete, and what comes back is the list the models
 * are chosen from.
 *
 * Nothing is written until the last step, and then as one channel with its
 * models and the defaults that were offered for it.
 */
export function AddProviderWizard({ onClose }: { onClose: () => void }) {
  const saving = useProviderStore((state) => state.saving);
  const channels = useProviderStore((state) => state.view?.channels ?? []);
  const stored = useProviderStore((state) => state.view?.defaults ?? null);

  const [step, setStep] = useState<Step>("address");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<ProviderProtocol | typeof AUTO>(
    AUTO,
  );
  const [checking, setChecking] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [defaults, setDefaults] = useState<Partial<Record<Capability, string>>>(
    {},
  );
  const [added, setAdded] = useState<string | null>(null);

  const chosen = models.filter((model) => model.id.trim() !== "");
  const coverage = coverageOf(chosen);
  // An address already configured is an update rather than a second copy, which
  // is what makes asking again safe — but it should not be a surprise.
  const replaces = inspection
    ? channels.find((channel) => channel.id === inspection.channelId)
    : undefined;

  /**
   * Asks the address what it offers.
   *
   * Stores nothing, so a wrong address or a wrong key costs a message here
   * rather than a channel to find and delete later.
   */
  const check = async () => {
    setChecking(true);
    setRefused(null);
    try {
      const answer = await providersApi.inspect({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || null,
        protocol: protocol === AUTO ? null : protocol,
      });
      setInspection(answer);
      if (!answer.ok) {
        setRefused(answer.error?.message ?? "The provider did not answer.");
      }
    } catch (error) {
      // An address that is not an address leaves nothing to derive a channel
      // from, so there is no next step to offer either.
      setInspection(null);
      setRefused(
        error instanceof Error
          ? error.message
          : "The address could not be asked.",
      );
    } finally {
      setChecking(false);
    }
  };

  /** Editing what was asked invalidates the answer to it. */
  const editAddress = (patch: {
    baseUrl?: string;
    apiKey?: string;
    protocol?: ProtocolChoice;
  }) => {
    setInspection(null);
    setRefused(null);
    if (patch.baseUrl !== undefined) setBaseUrl(patch.baseUrl);
    if (patch.apiKey !== undefined) setApiKey(patch.apiKey);
    if (patch.protocol !== undefined) setProtocol(patch.protocol);
  };

  const adopt = (ids: string[], capability: Capability) =>
    setModels((rows) => [
      ...rows,
      ...ids
        .filter((id) => !rows.some((row) => row.id === id))
        .map((id) => ({ ...newRow(capability), id })),
    ]);

  const editModel = (key: number, patch: Partial<ChannelModel>) =>
    setModels((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );

  const removeModel = (key: number) =>
    setModels((rows) => rows.filter((row) => row.key !== key));

  /**
   * Offers a default for each capability that gained exactly one model and has
   * no default yet.
   *
   * One model is an unambiguous answer, so it is offered rather than asked for.
   * Several is a choice that belongs to whoever is adding them, and a default
   * somebody already set for another channel is theirs to change: this adds a
   * provider, it does not rewrite the configuration around it.
   */
  const openDefaults = () => {
    const offered: Partial<Record<Capability, string>> = {};
    if (inspection && stored) {
      for (const capability of MODEL_CAPABILITIES) {
        if (stored[capability] !== null) continue;
        const serving = chosen.filter(
          (model) => model.enabled && model.capability === capability,
        );
        if (serving.length === 1) {
          offered[capability] = modelReference(
            inspection.channelId,
            serving[0].id.trim(),
          );
        }
      }
    }
    setDefaults(offered);
    setStep("defaults");
  };

  const finish = async () => {
    if (inspection === null) return;
    const saved = await useProviderStore.getState().saveChannel({
      id: inspection.channelId,
      name: inspection.channelName,
      baseUrl: inspection.baseUrl,
      protocol: inspection.protocol,
      enabled: true,
      models: chosen.map((model) => ({
        id: model.id.trim(),
        capability: model.capability,
        alias: model.alias.trim(),
        enabled: model.enabled,
      })),
      apiKey: apiKey.trim() || null,
    } satisfies ChannelDraft);
    if (!saved) return;

    const patch: DefaultsPatch = {};
    let moved = false;
    for (const capability of MODEL_CAPABILITIES) {
      const reference = defaults[capability];
      if (reference && stored?.[capability] === null) {
        patch[capability] = reference;
        moved = true;
      }
    }
    // The channel is stored either way. A default that could not be written
    // leaves a gap the Defaults tab names, which is better than losing the
    // channel that was just added.
    if (moved) await useProviderStore.getState().saveDefaults(patch);
    setAdded(inspection.channelName);
  };

  if (added !== null) {
    return (
      <div className="settings-section">
        <h3 className="settings-heading">{added} added</h3>
        <CoverageChips models={chosen} />
        {missing(coverage).length > 0 && (
          <p className="settings-hint">
            Nothing here makes{" "}
            {missing(coverage)
              .map((capability) => CAPABILITY_LABELS[capability].toLowerCase())
              .join(", ")}
            , so nodes of those kinds still need a model.
          </p>
        )}
        <div className="settings-row">
          <button className="primary" onClick={onClose} type="button">
            Back to the channels
          </button>
          <button
            onClick={() => useProviderStore.getState().setTab("defaults")}
            type="button"
          >
            Check the defaults
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section wizard">
      <h3 className="settings-heading">Add a provider</h3>
      <ol className="wizard-steps">
        {(["address", "models", "defaults"] as const).map((name, position) => (
          <li
            className={step === name ? "wizard-step is-current" : "wizard-step"}
            key={name}
          >
            {position + 1}. {STEP_LABELS[name]}
          </li>
        ))}
      </ol>

      {step === "address" && (
        <>
          <label className="dialog-field">
            <span>Provider address</span>
            <input
              aria-label="Provider address"
              onChange={(event) => editAddress({ baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
              type="url"
              value={baseUrl}
            />
          </label>
          <div className="settings-columns">
            <label className="dialog-field">
              <span>API key</span>
              <input
                aria-label="API key"
                onChange={(event) =>
                  editAddress({ apiKey: event.target.value })
                }
                placeholder="Needed to ask what it offers"
                type="password"
                value={apiKey}
              />
            </label>
            <label className="dialog-field">
              <span>Protocol</span>
              <select
                aria-label="Protocol"
                onChange={(event) =>
                  editAddress({
                    protocol: event.target.value as
                      ProviderProtocol | typeof AUTO,
                  })
                }
                value={protocol}
              >
                <option value="auto">Derived from the address</option>
                {PROVIDER_PROTOCOLS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {replaces && (
            <p className="settings-hint" data-testid="wizard-replaces">
              “{replaces.name}” is already configured at this address, so
              continuing updates that channel rather than adding a second copy.
            </p>
          )}
          {refused && (
            <p
              className="dialog-error"
              data-testid="wizard-refused"
              role="alert"
            >
              {refused}
            </p>
          )}
          {inspection?.ok && (
            <p
              className="settings-hint"
              data-testid="wizard-reached"
              role="status"
            >
              Reached {inspection.channelName} in {inspection.latencyMs} ms —{" "}
              {inspection.models.length} model
              {inspection.models.length === 1 ? "" : "s"} offered.
            </p>
          )}

          <div className="dialog-actions">
            <button disabled={saving} onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="primary"
              disabled={checking || baseUrl.trim() === ""}
              onClick={() => void check()}
              type="button"
            >
              {checking ? "Asking…" : "Ask what it offers"}
            </button>
            <button
              disabled={inspection === null || saving}
              onClick={() => setStep("models")}
              title={
                inspection === null
                  ? "Ask the address first: what it offers is what the next step chooses from"
                  : undefined
              }
              type="button"
            >
              {inspection?.ok ? "Choose models" : "Continue anyway"}
            </button>
          </div>
        </>
      )}

      {step === "models" && inspection !== null && (
        <>
          <p className="settings-hint">
            A model serves the nodes of its own kind: an image model cannot be
            pointed at a text node, and the run is refused if it is.
          </p>
          {chosen.length === 0 ? (
            <p className="settings-hint" data-testid="wizard-models-gap">
              No models chosen yet, so this channel will serve nothing.
            </p>
          ) : (
            <CoverageChips models={chosen} />
          )}

          <ModelRows
            models={models}
            onEdit={editModel}
            onRemove={removeModel}
          />
          <div className="settings-row">
            <button
              onClick={() =>
                setModels((rows) => [...rows, newRow(firstMissing(coverage))])
              }
              title="For a provider that does not list its models, or one that lists them under names it will not explain"
              type="button"
            >
              Add a model by hand
            </button>
          </div>

          {inspection.models.length > 0 ? (
            <CandidateList
              added={new Set(chosen.map((model) => model.id))}
              candidates={inspection.models}
              disabled={saving}
              onAdopt={adopt}
            />
          ) : (
            <p className="settings-hint">
              {refused ??
                "The provider listed no models, so they have to be typed in."}
            </p>
          )}

          <div className="dialog-actions">
            <button onClick={() => setStep("address")} type="button">
              Back
            </button>
            <button
              className="primary"
              disabled={saving}
              onClick={openDefaults}
              type="button"
            >
              Continue
            </button>
          </div>
        </>
      )}

      {step === "defaults" && inspection !== null && (
        <>
          <p className="settings-hint">
            A node that does not name a model of its own uses the default for
            its kind. One is offered where this provider is the only answer and
            none was set before.
          </p>
          <div className="settings-columns">
            {MODEL_CAPABILITIES.map((capability) => {
              const label = CAPABILITY_LABELS[capability];
              const serving = chosen.filter(
                (model) => model.enabled && model.capability === capability,
              );
              if (serving.length === 0) return null;
              // Somebody else's default is left alone: this adds a provider, it
              // does not rewrite the configuration around it.
              const already = stored?.[capability] ?? null;
              return (
                <label className="dialog-field" key={capability}>
                  <span>{label}</span>
                  <select
                    aria-label={`Default ${label} model`}
                    disabled={saving || already !== null}
                    onChange={(event) =>
                      setDefaults((state) => ({
                        ...state,
                        [capability]:
                          event.target.value === ""
                            ? undefined
                            : event.target.value,
                      }))
                    }
                    value={already ?? defaults[capability] ?? ""}
                  >
                    <option value="">No default</option>
                    {serving.map((model) => {
                      const reference = modelReference(
                        inspection.channelId,
                        model.id.trim(),
                      );
                      return (
                        <option key={reference} value={reference}>
                          {model.alias.trim() || model.id.trim()}
                        </option>
                      );
                    })}
                    {already !== null && (
                      <option value={already}>{already}</option>
                    )}
                  </select>
                  {already !== null && (
                    <span className="settings-hint">
                      Already set to another channel's model.
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <div className="dialog-actions">
            <button onClick={() => setStep("models")} type="button">
              Back
            </button>
            <button
              className="primary"
              disabled={saving}
              onClick={() => void finish()}
              type="button"
            >
              {saving
                ? "Adding…"
                : replaces
                  ? `Update ${replaces.name}`
                  : "Add the channel"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
