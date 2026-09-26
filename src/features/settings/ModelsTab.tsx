import { useTranslation } from "react-i18next";
import type { ModelView } from "../../api";
import { CAPABILITY_LABELS, type Capability } from "../../shared/domain";
import { ModelEditor } from "./ModelEditor";
import {
  effectiveDefaultId,
  musicDefaultId,
  protocolFeatures,
  protocolLabel,
  useModelStore,
} from "./modelStore";
import { SecretStorageNote } from "./SecretStorageNote";

function ModelCard({
  model,
  category,
  isDefault,
  isMusic,
}: {
  model: ModelView;
  category: Capability;
  isDefault: boolean;
  /** Whether this audio model is the one that composes the scores. */
  isMusic: boolean;
}) {
  const { t } = useTranslation();
  const saving = useModelStore((state) => state.saving);
  const protocols = useModelStore((state) => state.protocols);
  const lower = t(CAPABILITY_LABELS[category]).toLowerCase();

  const remove = () => {
    if (
      !window.confirm(
        t("settings:card.deleteConfirm", { name: model.displayName }),
      )
    ) {
      return;
    }
    void useModelStore.getState().removeModel(model.id);
  };

  return (
    <li className={`model-card${model.enabled ? "" : " is-off"}`}>
      <div className="model-card-head">
        <strong>{model.displayName}</strong>
        <span className="model-card-tag">
          {protocolLabel(protocols, model.protocol)}
        </span>
        {!model.enabled && (
          <span className="model-card-tag">{t("settings:card.off")}</span>
        )}
        <label className="settings-check">
          <input
            aria-label={t("settings:card.useAsDefault", {
              name: model.displayName,
              category: lower,
            })}
            checked={isDefault}
            disabled={saving}
            onChange={(event) =>
              void useModelStore
                .getState()
                .setDefault(category, event.target.checked ? model.id : null)
            }
            type="radio"
            name={`default-${category}`}
          />
          <span>{t("settings:card.default")}</span>
        </label>
        {category === "audio" && (
          // A second question about an audio model, because a telling asks two
          // of them: which one reads its lines aloud, and which one plays
          // under them. Unchosen, a score is asked of the audio default.
          <label className="settings-check">
            <input
              aria-label={t("settings:card.useAsMusic", {
                name: model.displayName,
              })}
              checked={isMusic}
              disabled={saving}
              onChange={() =>
                void useModelStore
                  .getState()
                  .setDefault("music", isMusic ? null : model.id)
              }
              type="radio"
              name="default-music"
            />
            <span>{t("settings:card.music")}</span>
          </label>
        )}
      </div>
      <p className="model-card-detail">
        {model.model} · <code>{model.url}</code>
      </p>
      <p className="model-card-detail">
        {model.apiKey.set
          ? t("settings:card.key", {
              masked: model.apiKey.masked ?? t("settings:card.stored"),
            })
          : t("settings:card.noKey")}
      </p>
      <div className="settings-row">
        <button
          disabled={saving}
          onClick={() => useModelStore.getState().editModel(model.id)}
          type="button"
        >
          {t("settings:edit")}
        </button>
        <button
          aria-label={t("settings:card.copy", { name: model.displayName })}
          disabled={saving}
          onClick={() => useModelStore.getState().duplicateModel(model.id)}
          title={t("settings:card.copyTip")}
          type="button"
        >
          {t("settings:duplicate")}
        </button>
        <button
          className="danger"
          disabled={saving}
          onClick={remove}
          type="button"
        >
          {t("settings:delete")}
        </button>
      </div>
    </li>
  );
}

/**
 * One category's models: what serves this kind of node, which of them is the
 * default, and the way to add, copy, or remove one.
 *
 * The default lives here rather than on a page of its own: it is a property of
 * the list beside it, and a picker far from the models it picks is how a
 * default ends up pointing at something nobody remembers choosing.
 */
export function ModelsTab({ category }: { category: Capability }) {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const saving = useModelStore((state) => state.saving);
  const editing = useModelStore((state) => state.editing);
  const copyOf = useModelStore((state) => state.copyOf);
  const protocols = useModelStore((state) => state.protocols);
  const lower = t(CAPABILITY_LABELS[category]).toLowerCase();

  if (editing !== null) {
    const model =
      editing === "new"
        ? null
        : (view?.models.find((entry) => entry.id === editing) ?? null);
    // A model deleted since the editor opened is not one to keep a form on.
    if (editing === "new" || model !== null) {
      const copySource =
        editing === "new" && copyOf !== null
          ? (view?.models.find((entry) => entry.id === copyOf) ?? null)
          : null;
      return (
        <ModelEditor
          category={model?.category ?? category}
          model={model}
          copySource={copySource}
          onDone={() => useModelStore.getState().closeEditor()}
        />
      );
    }
  }

  const models = (view?.models ?? []).filter(
    (model) => model.category === category,
  );
  // The default nobody had to pick: the stored choice when it still serves,
  // and the first enabled model otherwise — the same fallback the server
  // resolves a generation through.
  const defaultId = effectiveDefaultId(view, category);
  const musicId = category === "audio" ? musicDefaultId(view) : null;
  // The model an ask falls back to, and the one gap only it can have: a speech
  // model is asked for a voice, so a machine that has set none is a machine
  // whose read-aloud asks come back refused. Which converters need one is the
  // converter's own declaration, not a list this program keeps.
  const fallback = models.find((model) => model.id === defaultId);
  const voiceGap =
    category === "audio" &&
    fallback !== undefined &&
    protocolFeatures(protocols, fallback.protocol).needsVoice === true &&
    (view?.preferences.audio.voice ?? "").trim() === "";

  return (
    <div className="settings-section">
      <div className="settings-row">
        <button
          className="primary"
          disabled={saving}
          onClick={() => useModelStore.getState().newModel(category)}
          type="button"
        >
          {t("settings:models.new", { category: lower })}
        </button>
      </div>

      {models.length === 0 ? (
        <p className="settings-hint" data-testid={`${category}-empty`}>
          {t("settings:models.empty", { category: lower })}
        </p>
      ) : (
        <>
          <ul className="model-card-list">
            {models.map((model) => (
              <ModelCard
                category={category}
                isDefault={model.id === defaultId}
                isMusic={model.id === musicId}
                key={model.id}
                model={model}
              />
            ))}
          </ul>
          {defaultId === null && (
            <p className="settings-hint" data-testid={`${category}-gap`}>
              {t("settings:models.gap", { category: lower })}
            </p>
          )}
          {category === "audio" && musicId === null && (
            <p className="settings-hint" data-testid="audio-music-gap">
              {t("settings:models.musicGap")}
            </p>
          )}
          {voiceGap && (
            <p className="settings-hint" data-testid="audio-voice-gap">
              {t("settings:models.voiceGap")}
            </p>
          )}
        </>
      )}

      {view && <SecretStorageNote tier={view.secretStorage} />}
    </div>
  );
}
