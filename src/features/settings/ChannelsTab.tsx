import { useState } from "react";
import type { ChannelView } from "../../api";
import { AddProviderWizard } from "./AddProviderWizard";
import { ChannelEditor } from "./ChannelEditor";
import { CoverageChips } from "./CoverageChips";
import { useProviderStore } from "./providerStore";
import { SecretStorageNote } from "./SecretStorageNote";

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
  // Local rather than in the store: nothing outside this tab has a reason to
  // open the wizard, while a channel's editor is reached from a node.
  const [adding, setAdding] = useState(false);
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

  if (adding) {
    return <AddProviderWizard onClose={() => setAdding(false)} />;
  }

  const channels = view?.channels ?? [];

  return (
    <div className="settings-section">
      <div className="settings-row">
        <button
          className="primary"
          disabled={saving}
          onClick={() => setAdding(true)}
          type="button"
        >
          Add a provider
        </button>
      </div>

      {channels.length === 0 ? (
        <p className="settings-hint">
          No channels yet. Add one above: an address and a key are asked what
          they offer before anything is stored.
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
          title="Fill in a channel without asking its provider anything, for an address that lists no models"
          type="button"
        >
          Write one out in full
        </button>
      </div>

      {view && <SecretStorageNote tier={view.secretStorage} />}
    </div>
  );
}
