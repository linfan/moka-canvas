import { useState, type FormEvent } from "react";
import type { ChannelView } from "../../api";
import { ChannelEditor } from "./ChannelEditor";
import { CoverageChips } from "./CoverageChips";
import { useProviderStore } from "./providerStore";
import { SecretStorageNote } from "./SecretStorageNote";

/**
 * The address-and-key shortcut. Everything else about the channel is derived
 * from the address, so this stays usable next to the full editor without the
 * two ever disagreeing: importing an address that is already configured
 * updates that channel rather than adding a second copy of it.
 */
function QuickImport({ disabled }: { disabled: boolean }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const ready = !disabled && baseUrl.trim().length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const saved = await useProviderStore.getState().importChannel({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() || null,
    });
    if (saved) {
      setBaseUrl("");
      setApiKey("");
    }
  };

  return (
    <form className="settings-inline" onSubmit={(event) => void submit(event)}>
      <input
        aria-label="Provider address"
        onChange={(event) => setBaseUrl(event.target.value)}
        placeholder="https://api.example.com/v1"
        type="url"
        value={baseUrl}
      />
      <input
        aria-label="API key"
        onChange={(event) => setApiKey(event.target.value)}
        placeholder="API key (optional)"
        type="password"
        value={apiKey}
      />
      <button disabled={!ready} type="submit">
        Add
      </button>
    </form>
  );
}

function ChannelRow({
  channel,
  onEdit,
}: {
  channel: ChannelView;
  onEdit: () => void;
}) {
  const saving = useProviderStore((state) => state.saving);
  const activity = useProviderStore((state) => state.activity[channel.id]);
  const probe = activity?.probe ?? null;

  const remove = () => {
    const models = channel.models.length;
    const detail = models === 0 ? "" : ` and its ${models} model`;
    if (
      !window.confirm(
        `Delete “${channel.name}”${detail}${models === 1 ? "" : "s"}? The stored key goes with it.`,
      )
    ) {
      return;
    }
    void useProviderStore.getState().removeChannel(channel.id);
  };

  return (
    <li className={`channel${channel.enabled ? "" : " is-off"}`}>
      <div className="channel-head">
        <strong>{channel.name}</strong>
        <span className="channel-tag">{channel.protocol}</span>
        {!channel.enabled && <span className="channel-tag">off</span>}
      </div>
      <p className="channel-detail">{channel.baseUrl}</p>
      <p className="channel-detail">
        {channel.apiKey.set
          ? `Key ${channel.apiKey.masked ?? "stored"}`
          : "No key stored"}
        {" · "}
        {channel.models.length} model{channel.models.length === 1 ? "" : "s"}
      </p>
      {channel.models.length === 0 ? (
        <p className="channel-gap" data-testid="channel-gap">
          No models yet, so no node can use this channel.
          <button disabled={saving} onClick={onEdit} type="button">
            Add models
          </button>
        </p>
      ) : (
        <CoverageChips models={channel.models} />
      )}
      {probe && (
        <p
          className={probe.ok ? "channel-probe" : "channel-probe is-failed"}
          role="status"
        >
          {probe.ok
            ? `Reached in ${probe.latencyMs} ms`
            : `${probe.error?.code ?? "UNREACHABLE"}: ${probe.error?.message ?? "no answer"}`}
        </p>
      )}
      <div className="settings-row">
        <button disabled={saving} onClick={onEdit} type="button">
          Edit
        </button>
        {channel.models.length > 0 && channel.apiKey.set && (
          <button
            aria-label={`Refresh the models ${channel.name} offers`}
            disabled={saving}
            onClick={() =>
              void useProviderStore.getState().refreshModels(channel.id)
            }
            title="Stores what the provider lists now, keeping the kind, name and switch you chose for a model it still lists"
            type="button"
          >
            Refresh models
          </button>
        )}
        <button
          aria-label={`Test the connection to ${channel.name}`}
          disabled={saving || activity?.probing === true}
          onClick={() => void useProviderStore.getState().probe(channel.id)}
          type="button"
        >
          {activity?.probing ? "Testing…" : "Test"}
        </button>
        <button
          className="danger"
          disabled={saving}
          onClick={remove}
          type="button"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

export function ChannelsTab() {
  const view = useProviderStore((state) => state.view);
  const saving = useProviderStore((state) => state.saving);
  // Held in the store rather than here: a node that cannot run has to be able
  // to open the editor on the channel that would serve it, from outside this
  // tab, and that is not a thing a local state can be asked to do.
  const editing = useProviderStore((state) => state.editing);

  if (editing !== null) {
    const channel =
      editing === "new"
        ? null
        : (view?.channels.find((entry) => entry.id === editing) ?? null);
    // A channel that has been deleted since the editor opened is not one to
    // keep a form open on.
    if (editing === "new" || channel !== null) {
      return (
        <ChannelEditor
          channel={channel}
          onDone={() => useProviderStore.getState().closeEditor()}
        />
      );
    }
  }

  const channels = view?.channels ?? [];

  return (
    <div className="settings-section">
      <QuickImport disabled={saving} />

      {channels.length === 0 ? (
        <p className="settings-hint">
          No channels yet. Add one by address above, or fill in a channel in
          full.
        </p>
      ) : (
        <ul className="channel-list">
          {channels.map((channel) => (
            <ChannelRow
              channel={channel}
              key={channel.id}
              onEdit={() => useProviderStore.getState().editChannel(channel.id)}
            />
          ))}
        </ul>
      )}

      <div className="settings-row">
        <button
          disabled={saving}
          onClick={() => useProviderStore.getState().editChannel("new")}
          type="button"
        >
          New channel
        </button>
      </div>

      {view && <SecretStorageNote tier={view.secretStorage} />}
    </div>
  );
}
