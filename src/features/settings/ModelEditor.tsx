import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ModelDraft,
  ModelView,
  ProtocolGroups,
  SubModel,
} from "../../api";
import {
  CAPABILITY_LABELS,
  MAX_MODEL_ID_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  MAX_VIDEO_SECONDS,
  MODEL_SCENE_LABELS,
  SCENES_OF_CATEGORY,
  type Capability,
  type ModelScene,
} from "../../shared/domain";
import {
  protocolChoices,
  protocolLabel,
  protocolUrlExample,
  useModelStore,
} from "./modelStore";
import { uniqueModelId } from "./modelId";

interface Props {
  /** The stored configuration being edited, or null for a new one. */
  model: ModelView | null;
  /** The configuration a new one is a copy of, or null for a plain new one. */
  copySource?: ModelView | null;
  /** The category a new configuration starts on. */
  category: Capability;
  onDone: () => void;
}

interface FormState {
  id: string;
  /** Whether the identifier was typed, or is still the suggested one. */
  idTouched: boolean;
  /** The id of a converter directory, which is the protocol's wire name. */
  protocol: string;
  url: string;
  model: string;
  displayName: string;
  /** The longest one clip may be, as text so a blank field can mean none. */
  maxVideoSeconds: string;
  /** Per-scenario rows; empty means the one model answers everything. */
  subModels: SubModelDraft[];
  enabled: boolean;
  apiKey: string;
}

/**
 * One scenario row as the form holds it: the address as text so a blank field
 * can mean "wherever the main one asks".
 */
export interface SubModelDraft {
  model: string;
  url: string;
  scenes: ModelScene[];
}

/**
 * The rows with one scene's check moved to the row that just took it.
 *
 * A scenario is answered by at most one sub-model, so checking it somewhere
 * takes it from wherever it was: two rows both claiming one scene would be a
 * configuration the server refuses, and a form that can build one is a form
 * that fails at save.
 */
export function toggleScene(
  rows: SubModelDraft[],
  at: number,
  scene: ModelScene,
  checked: boolean,
): SubModelDraft[] {
  return rows.map((row, index) => {
    if (index === at) {
      const scenes = checked
        ? [...row.scenes.filter((held) => held !== scene), scene]
        : row.scenes.filter((held) => held !== scene);
      return { ...row, scenes };
    }
    return checked && row.scenes.includes(scene)
      ? { ...row, scenes: row.scenes.filter((held) => held !== scene) }
      : row;
  });
}

/** The scenes no row answers for, in the category's own order. */
export function uncoveredScenes(
  category: Capability,
  rows: SubModelDraft[],
): ModelScene[] {
  const claimed = new Set(rows.flatMap((row) => row.scenes));
  return SCENES_OF_CATEGORY[category].filter((scene) => !claimed.has(scene));
}

/** What one row is missing, as a message key, or null when it is complete. */
export function subModelProblem(row: SubModelDraft): string | null {
  if (row.model.trim() === "") return "settings:editor.subModelNeedsModel";
  if (row.url.trim() !== "" && !/^https?:\/\/\S+$/.test(row.url.trim())) {
    return "settings:editor.subModelUrlBad";
  }
  if (row.scenes.length === 0) return "settings:editor.subModelNeedsScene";
  return null;
}

/** The stored rows as the form holds them. */
function draftRows(subModels: SubModel[] | undefined): SubModelDraft[] {
  return (subModels ?? []).map((sub) => ({
    model: sub.model,
    url: sub.url ?? "",
    scenes: [...sub.scenes],
  }));
}

function initialForm(
  model: ModelView | null,
  copySource: ModelView | null,
  category: Capability,
  protocols: ProtocolGroups | null,
): FormState {
  if (model === null && copySource !== null) {
    // A copy starts from the source's fields, including the protocol it may
    // alone speak; the identifier is left to the suggestion, which follows
    // the display name the way a plain new model's does.
    return {
      id: "",
      idTouched: false,
      protocol: copySource.protocol,
      url: copySource.url,
      model: copySource.model,
      displayName: `${copySource.displayName} (copy)`.slice(
        0,
        MAX_MODEL_NAME_LENGTH,
      ),
      maxVideoSeconds: ceilingText(copySource.maxVideoSeconds),
      subModels: draftRows(copySource.subModels),
      enabled: copySource.enabled,
      apiKey: "",
    };
  }
  if (model === null) {
    // A category whose shapes all come from the converter registry has
    // nothing to offer until that has been read — recognition is one — so the
    // form may start with no protocol at all and adopt one when it arrives.
    const choice = protocolChoices(protocols, category)[0] ?? null;
    return {
      id: "",
      idTouched: false,
      protocol: choice?.id ?? "",
      url: choice?.urlExample ?? "",
      model: "",
      displayName: "",
      maxVideoSeconds: "",
      subModels: [],
      enabled: true,
      apiKey: "",
    };
  }
  return {
    id: model.id,
    idTouched: true,
    protocol: model.protocol,
    url: model.url,
    model: model.model,
    displayName: model.displayName,
    maxVideoSeconds: ceilingText(model.maxVideoSeconds),
    subModels: draftRows(model.subModels),
    enabled: model.enabled,
    apiKey: "",
  };
}

/** A stored clip ceiling as the field shows it: a number, or nothing. */
function ceilingText(seconds: number | null | undefined): string {
  return seconds == null ? "" : String(seconds);
}

/**
 * One model configuration, written out in full.
 *
 * There is no provider to inherit from: the address is the complete endpoint,
 * the protocol says what shape arrives there, and the key belongs to this
 * model alone. A copy of another configuration is a starting point rather
 * than a relationship — duplicating carries the fields and the key, and the
 * two can then diverge without touching each other.
 *
 * The identifier is the one field nobody has to think about: it is suggested
 * from the display name and can be overwritten, because what it does — stay
 * the reference a node holds — matters more than what it reads as.
 */
export function ModelEditor({
  model,
  copySource = null,
  category,
  onDone,
}: Props) {
  const { t } = useTranslation();
  const saving = useModelStore((state) => state.saving);
  const view = useModelStore((state) => state.view);
  const protocols = useModelStore((state) => state.protocols);
  const [form, setForm] = useState<FormState>(() =>
    initialForm(model, copySource, category, protocols),
  );

  const edit = (patch: Partial<FormState>) =>
    setForm((state) => ({ ...state, ...patch }));

  /**
   * What the protocol picker offers. A stored configuration whose script
   * has since left the registry still gets a line, so the form names what
   * is saved instead of silently falling back to another shape.
   */
  const choices = useMemo(() => {
    const offered = protocolChoices(protocols, category);
    const storedMissing =
      form.protocol !== "" &&
      !offered.some((choice) => choice.id === form.protocol);
    return storedMissing
      ? [
          {
            id: form.protocol,
            label: protocolLabel(protocols, form.protocol),
            urlExample: protocolUrlExample(protocols, form.protocol),
          },
          ...offered,
        ]
      : offered;
  }, [protocols, category, form.protocol]);

  const chooseProtocol = (protocol: string) => {
    // A form still carrying the example of the previous shape adopts the
    // new one; an address somebody typed is theirs to keep.
    const previousExample = protocolUrlExample(protocols, form.protocol);
    const nextExample = protocolUrlExample(protocols, protocol);
    const url =
      form.url.trim() === "" || form.url.trim() === previousExample
        ? nextExample
        : form.url;
    edit({ protocol, url });
  };

  // The registry may land after the form was opened, which is the only case a
  // form begins with no shape chosen. Adopted here rather than left to the
  // picker's default, because a picker with nothing in it cannot be saved.
  useEffect(() => {
    if (form.protocol !== "" || choices.length === 0) return;
    setForm((state) => ({
      ...state,
      protocol: choices[0].id,
      url: choices[0].urlExample,
    }));
  }, [choices, form.protocol]);

  /** Whether a stored configuration already answers to an identifier. */
  const isTaken = useCallback(
    (candidate: string) =>
      (view?.models ?? []).some(
        (entry) => entry.id.toLowerCase() === candidate.toLowerCase(),
      ),
    [view],
  );

  /**
   * The identifier this form will save.
   *
   * A new configuration is handed one derived from its display name, which
   * follows the name as it is typed — writing an identifier is optional,
   * having one is not. Typing one takes over, and clearing the field hands it
   * back to the suggestion rather than saving nothing. An existing
   * configuration's identifier is the one its nodes already store.
   */
  const identifier = useMemo(() => {
    if (model !== null) return model.id;
    if (form.idTouched) return form.id.trim();
    return uniqueModelId(form.displayName, isTaken);
  }, [model, form.idTouched, form.id, form.displayName, isTaken]);

  const chooseId = (typed: string) => {
    if (typed.trim() === "") {
      edit({ id: "", idTouched: false });
      return;
    }
    edit({ id: typed, idTouched: true });
  };

  const idTaken = model === null && isTaken(identifier);
  const idShaped = !/\s/.test(identifier);
  const idProblem = idTaken
    ? t("settings:editor.identifierTaken")
    : idShaped
      ? null
      : t("settings:editor.identifierSpaces");
  const urlShaped = /^https?:\/\/\S+$/.test(form.url.trim());
  // A clip ceiling is a video model's alone, and a number outside what one
  // clip may be is nothing to plan with: the field says so before the save.
  const ceilingText = form.maxVideoSeconds.trim();
  const ceilingNumber = ceilingText === "" ? null : Number(ceilingText);
  const ceilingOk =
    ceilingText === "" ||
    (ceilingNumber !== null &&
      Number.isInteger(ceilingNumber) &&
      ceilingNumber >= 1 &&
      ceilingNumber <= MAX_VIDEO_SECONDS);
  const canSave =
    !saving &&
    !idTaken &&
    idShaped &&
    form.protocol !== "" &&
    form.displayName.trim() !== "" &&
    form.model.trim() !== "" &&
    ceilingOk &&
    urlShaped &&
    form.subModels.every((row) => subModelProblem(row) === null);
  // The scenarios a routed category has that no row answers for. Only said
  // once routing exists: a configuration with no sub-models answers every
  // scenario itself, which is how one behaved before the rows existed.
  const uncovered =
    category === "image" || category === "video"
      ? uncoveredScenes(category, form.subModels)
      : [];

  const save = async () => {
    const draft: ModelDraft = {
      id: identifier,
      category,
      protocol: form.protocol,
      url: form.url.trim(),
      model: form.model.trim(),
      displayName: form.displayName.trim(),
      enabled: form.enabled,
    };
    // Only a video model keeps a ceiling: the other categories have no such
    // window, and a form that never showed the field leaves it out entirely.
    if (category === "video" && ceilingNumber !== null) {
      draft.maxVideoSeconds = ceilingNumber;
    }
    // Scenario routing belongs to video and image models, and the rows travel
    // only where there is something to say — or something stored to clear.
    if (
      (category === "image" || category === "video") &&
      (form.subModels.length > 0 || (model?.subModels?.length ?? 0) > 0)
    ) {
      draft.subModels = form.subModels.map((row) => ({
        model: row.model.trim(),
        ...(row.url.trim() === "" ? {} : { url: row.url.trim() }),
        scenes: [...row.scenes],
      }));
    }
    // A blank key field keeps whatever is stored; typing one replaces it.
    // Clearing is its own button, so saving an unrelated edit cannot cost a
    // working key. A copy names its source instead: the client never sees
    // the key, so the server takes it from the configuration being copied.
    if (form.apiKey.trim() !== "") {
      draft.apiKey = form.apiKey.trim();
    } else if (model === null && copySource !== null) {
      draft.copyKeyFrom = copySource.id;
    }
    const saved = await useModelStore.getState().saveModel(draft);
    if (saved) onDone();
  };

  const clearKey = async () => {
    if (model === null) return;
    if (
      !window.confirm(
        t("settings:editor.clearKeyConfirm", { name: model.displayName }),
      )
    ) {
      return;
    }
    await useModelStore.getState().setKey(model.id, null);
    onDone();
  };

  return (
    <div className="settings-section">
      <h3 className="settings-heading">
        {model !== null
          ? // The category went out of the form as a field of its own; the
            // heading is where an editor says which kind of model this is,
            // because the protocol choices below follow from it.
            t("settings:editor.headingEdit", {
              name: model.displayName,
              category: t(CAPABILITY_LABELS[category]).toLowerCase(),
            })
          : copySource !== null
            ? t("settings:editor.headingCopy", {
                name: copySource.displayName,
                category: t(CAPABILITY_LABELS[category]).toLowerCase(),
              })
            : t("settings:editor.headingNew", {
                category: t(CAPABILITY_LABELS[category]).toLowerCase(),
              })}
      </h3>

      <label className="dialog-field">
        <span>{t("settings:editor.displayName")}</span>
        <input
          aria-label={t("settings:editor.displayName")}
          autoFocus
          maxLength={MAX_MODEL_NAME_LENGTH}
          onChange={(event) => edit({ displayName: event.target.value })}
          placeholder={t("settings:editor.displayNameTip")}
          value={form.displayName}
        />
      </label>

      <label className="dialog-field">
        <span>{t("settings:editor.identifier")}</span>
        <input
          aria-label={t("settings:editor.identifierAria")}
          disabled={model !== null}
          maxLength={MAX_MODEL_ID_LENGTH}
          onChange={(event) => chooseId(event.target.value)}
          title={
            model !== null
              ? t("settings:editor.identifierLockedTip")
              : undefined
          }
          value={identifier}
        />
      </label>
      {model === null && (
        <p className="settings-hint">{t("settings:editor.identifierHint")}</p>
      )}
      {idProblem && (
        <p className="settings-hint" role="alert">
          {idProblem}
        </p>
      )}

      <label className="dialog-field">
        <span>{t("settings:editor.protocol")}</span>
        <select
          aria-label={t("settings:editor.protocol")}
          onChange={(event) => chooseProtocol(event.target.value)}
          value={form.protocol}
        >
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {choices.length === 0 && (
        <p className="settings-hint" role="alert">
          {t("settings:editor.noProtocols")}
        </p>
      )}

      <label className="dialog-field">
        <span>{t("settings:editor.url")}</span>
        <input
          aria-label={t("settings:editor.urlAria")}
          onChange={(event) => edit({ url: event.target.value })}
          placeholder={protocolUrlExample(protocols, form.protocol)}
          value={form.url}
        />
      </label>
      <p className="settings-hint">
        {urlShaped
          ? t("settings:editor.urlHint")
          : `${t("settings:editor.urlHint")} ${t("settings:editor.urlHintScheme")}`}
      </p>

      <label className="dialog-field">
        <span>{t("settings:editor.modelName")}</span>
        <input
          aria-label={t("settings:editor.modelName")}
          maxLength={MAX_MODEL_NAME_LENGTH}
          onChange={(event) => edit({ model: event.target.value })}
          placeholder={t("settings:editor.modelNameTip")}
          value={form.model}
        />
      </label>

      {category === "video" && (
        <>
          <label className="dialog-field">
            <span>{t("settings:editor.maxVideoSeconds")}</span>
            <input
              aria-label={t("settings:editor.maxVideoSeconds")}
              max={MAX_VIDEO_SECONDS}
              min={1}
              onChange={(event) =>
                edit({ maxVideoSeconds: event.target.value })
              }
              placeholder="—"
              step={1}
              type="number"
              value={form.maxVideoSeconds}
            />
          </label>
          <p className="settings-hint">
            {ceilingOk
              ? t("settings:editor.maxVideoSecondsHint")
              : t("settings:editor.maxVideoSecondsRange", {
                  max: MAX_VIDEO_SECONDS,
                })}
          </p>
        </>
      )}

      {(category === "image" || category === "video") && (
        <>
          <h4 className="settings-heading">{t("settings:editor.subModels")}</h4>
          <p className="settings-hint">{t("settings:editor.subModelsHint")}</p>
          {form.subModels.map((row, at) => {
            const problem = subModelProblem(row);
            return (
              <div className="settings-sub-model" key={at}>
                <label className="dialog-field">
                  <span>{t("settings:editor.subModelModel")}</span>
                  <input
                    aria-label={`${t("settings:editor.subModelModel")} ${at + 1}`}
                    data-testid={`model-sub-${at}-model`}
                    maxLength={MAX_MODEL_NAME_LENGTH}
                    onChange={(event) =>
                      edit({
                        subModels: form.subModels.map((held, index) =>
                          index === at
                            ? { ...held, model: event.target.value }
                            : held,
                        ),
                      })
                    }
                    placeholder={t("settings:editor.subModelModelTip")}
                    value={row.model}
                  />
                </label>
                <label className="dialog-field">
                  <span>{t("settings:editor.subModelUrl")}</span>
                  <input
                    aria-label={`${t("settings:editor.subModelUrl")} ${at + 1}`}
                    data-testid={`model-sub-${at}-url`}
                    onChange={(event) =>
                      edit({
                        subModels: form.subModels.map((held, index) =>
                          index === at
                            ? { ...held, url: event.target.value }
                            : held,
                        ),
                      })
                    }
                    placeholder={
                      form.url.trim() === ""
                        ? t("settings:editor.subModelUrlTip")
                        : form.url.trim()
                    }
                    value={row.url}
                  />
                </label>
                <div className="settings-row">
                  {SCENES_OF_CATEGORY[category].map((scene) => (
                    <label className="settings-check" key={scene}>
                      <input
                        aria-label={`${t("settings:editor.subModelScene")} ${at + 1} ${t(MODEL_SCENE_LABELS[scene])}`}
                        checked={row.scenes.includes(scene)}
                        data-testid={`model-sub-${at}-scene-${scene}`}
                        onChange={(event) =>
                          edit({
                            subModels: toggleScene(
                              form.subModels,
                              at,
                              scene,
                              event.target.checked,
                            ),
                          })
                        }
                        type="checkbox"
                      />
                      <span>{t(MODEL_SCENE_LABELS[scene])}</span>
                    </label>
                  ))}
                  <button
                    aria-label={`${t("settings:editor.subModelRemove")} ${at + 1}`}
                    data-testid={`model-sub-${at}-remove`}
                    onClick={() =>
                      edit({
                        subModels: form.subModels.filter(
                          (_held, index) => index !== at,
                        ),
                      })
                    }
                    type="button"
                  >
                    {t("settings:editor.subModelRemove")}
                  </button>
                </div>
                {problem !== null && (
                  <p className="settings-hint" role="alert">
                    {t(problem)}
                  </p>
                )}
              </div>
            );
          })}
          <div className="settings-row">
            <button
              data-testid="model-sub-add"
              onClick={() =>
                edit({
                  subModels: [
                    ...form.subModels,
                    { model: "", url: "", scenes: [] },
                  ],
                })
              }
              type="button"
            >
              {t("settings:editor.subModelAdd")}
            </button>
          </div>
          {form.subModels.length > 0 && uncovered.length > 0 && (
            <p
              className="settings-hint"
              role="status"
              data-testid="model-sub-uncovered"
            >
              {t("settings:editor.subModelsUncovered")}{" "}
              {uncovered
                .map((scene) => t(MODEL_SCENE_LABELS[scene]))
                .join(" / ")}
            </p>
          )}
        </>
      )}

      <label className="dialog-field">
        <span>{t("settings:editor.apiKey")}</span>
        <input
          aria-label={t("settings:editor.apiKey")}
          onChange={(event) => edit({ apiKey: event.target.value })}
          placeholder={
            model?.apiKey.set
              ? t("settings:editor.keyStoredTip", {
                  masked: model.apiKey.masked ?? t("settings:keyFallback"),
                })
              : copySource?.apiKey.set
                ? t("settings:editor.keyCopiedTip", {
                    name: copySource.displayName,
                  })
                : "sk-…"
          }
          type="password"
          value={form.apiKey}
        />
      </label>
      {model !== null && model.apiKey.set && (
        <div className="settings-row">
          <button disabled={saving} onClick={clearKey} type="button">
            {t("settings:editor.clearKey")}
          </button>
        </div>
      )}

      <label className="settings-check">
        <input
          aria-label={t("settings:editor.enabled")}
          checked={form.enabled}
          onChange={(event) => edit({ enabled: event.target.checked })}
          type="checkbox"
        />
        <span>{t("settings:editor.enabled")}</span>
      </label>

      <div className="dialog-actions">
        <button
          className="primary"
          disabled={!canSave}
          onClick={() => void save()}
          type="button"
        >
          {saving ? t("settings:saving") : t("settings:editor.save")}
        </button>
        <button disabled={saving} onClick={onDone} type="button">
          {t("settings:cancel")}
        </button>
      </div>
    </div>
  );
}
