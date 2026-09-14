import { useEffect, useMemo, useState } from "react";
import { assetUrl } from "../../../api";
import {
  CAPABILITY_LABELS,
  PROJECT_ASSET_CATEGORIES,
  type AssetId,
  type Capability,
  type ResourceEntry,
} from "../../../shared/domain";
import { addAssetNodes, attachAssetsToNode } from "../interactions/actions";
import {
  OPEN_SHELF_FILTER,
  SHELF_GLYPHS,
  SHELF_KINDS,
  filterShelf,
  kindOfShelf,
  shelfTags,
  type ShelfFilter,
} from "../panels/shelfFilter";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

/** Which kind of thing a file is, read off the shelf it is filed on. */
function kindOf(entry: ResourceEntry): Capability {
  const shelf = entry.path.split("/")[1];
  const category = PROJECT_ASSET_CATEGORIES.find((name) => name === shelf);
  return kindOfShelf(category ?? "texts");
}

/**
 * The picture a row leads with, when the file has one to show.
 *
 * A moving picture shows the still that was taken of it, since a row cannot
 * play a shot; a file with nothing to show leads with the mark of its shelf.
 */
function thumbOf(entry: ResourceEntry): string | null {
  const mime = entry.mime ?? entry.probe?.mime ?? "";
  if (mime.startsWith("image/")) return assetUrl(entry.id);
  const poster = entry.probe?.posterAssetId;
  return mime.startsWith("video/") && poster ? assetUrl(poster) : null;
}

/**
 * The words a row leads with, where there is no picture to show.
 *
 * What a file carries about itself — the summary of the text it holds or the
 * ask it came from — is its thumbnail, cut short by the row rather than by
 * the file.
 */
function excerptOf(entry: ResourceEntry): string {
  return entry.keyword?.trim() || entry.note?.trim() || "";
}

/**
 * One question: which files off the shelf, and several may be answered at once.
 *
 * Two kinds of ask share one dialog, because the choosing is the same in both
 * and only what happens afterwards differs: what is chosen either becomes nodes
 * of its own, or is given to the node whose panel asked. What it will come to
 * is stated on the dialog before anything is taken, since a pick of ten files
 * is ten nodes or ten references and neither is obvious from the list alone.
 */
export function AssetPickerModal() {
  const ask = useEditorStore((state) => state.assetPicker);
  const moka = useProjectStore((state) => state.moka);
  const [filter, setFilter] = useState<ShelfFilter>(OPEN_SHELF_FILTER);
  const [chosen, setChosen] = useState<AssetId[]>([]);
  const [busy, setBusy] = useState(false);

  // Each opening starts clean: a dialog that kept the last answer's ticks would
  // add files nobody chose yet to whatever is asked of it now.
  useEffect(() => {
    if (!ask) return;
    setFilter(OPEN_SHELF_FILTER);
    setChosen([]);
  }, [ask]);

  useEffect(() => {
    if (!ask) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") useEditorStore.getState().closeAssetPicker();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ask]);

  const entries = useMemo(
    () => (moka ? filterShelf(moka.resources, filter) : []),
    [moka, filter],
  );
  const words = useMemo(() => (moka ? shelfTags(moka.resources) : []), [moka]);

  if (!ask) return null;

  const close = () => useEditorStore.getState().closeAssetPicker();
  const toggle = (assetId: AssetId) =>
    setChosen((seen) =>
      seen.includes(assetId)
        ? seen.filter((id) => id !== assetId)
        : [...seen, assetId],
    );
  const take = async () => {
    setBusy(true);
    try {
      if (ask.mode === "nodes") {
        await addAssetNodes(chosen, ask.at ?? undefined);
      } else {
        await attachAssetsToNode(ask.nodeId, chosen);
      }
      close();
    } finally {
      setBusy(false);
    }
  };

  const count =
    chosen.length === 0
      ? "Nothing is chosen yet"
      : ask.mode === "nodes"
        ? `Will be inserted as ${chosen.length} node${
            chosen.length === 1 ? "" : "s"
          }`
        : `Will be added as ${chosen.length} reference${
            chosen.length === 1 ? "" : "s"
          }`;
  const title =
    ask.mode === "nodes" ? "Insert from the shelf" : "Add from the shelf";

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        aria-label={title}
        aria-modal="true"
        className="dialog asset-pick-dialog"
        data-testid="asset-picker"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="preview-dialog-head">
          <h2>{title}</h2>
          <button aria-label="Close the picker" onClick={close} type="button">
            ✕
          </button>
        </header>

        <div className="asset-pick-filter">
          <input
            aria-label="Search the shelf"
            data-testid="asset-pick-asked"
            onChange={(event) =>
              setFilter((seen) => ({ ...seen, asked: event.target.value }))
            }
            placeholder="Name, word, note, or summary"
            type="search"
            value={filter.asked}
          />
          <select
            aria-label="Which kind"
            data-testid="asset-pick-category"
            onChange={(event) =>
              setFilter((seen) => ({
                ...seen,
                kind: (event.target.value || null) as Capability | null,
              }))
            }
            value={filter.kind ?? ""}
          >
            <option value="">Every kind</option>
            {SHELF_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {CAPABILITY_LABELS[kind]}
              </option>
            ))}
          </select>
          {words.length > 0 && (
            <div
              aria-label="Filed under"
              className="side-shelf-tags"
              role="group"
            >
              {words.map(({ count: carried, tag }) => (
                <button
                  aria-pressed={filter.tags.includes(tag)}
                  className={`side-shelf-tag${
                    filter.tags.includes(tag) ? " is-active" : ""
                  }`}
                  data-testid={`asset-pick-tag-${tag}`}
                  key={tag}
                  onClick={() =>
                    setFilter((seen) => ({
                      ...seen,
                      tags: seen.tags.includes(tag)
                        ? seen.tags.filter((word) => word !== tag)
                        : [...seen.tags, tag],
                    }))
                  }
                  type="button"
                >
                  {tag} · {carried}
                </button>
              ))}
            </div>
          )}
        </div>

        {entries.length === 0 ? (
          <p className="prompt-panel-note" data-testid="asset-pick-none">
            Nothing on the shelf matches.
          </p>
        ) : (
          <ul aria-label="Files on the shelf" className="asset-pick-list">
            {entries.map((entry) => {
              const kind = kindOf(entry);
              const thumb = thumbOf(entry);
              const excerpt = excerptOf(entry);
              const shelf = PROJECT_ASSET_CATEGORIES.find(
                (name) => name === entry.path.split("/")[1],
              );
              return (
                <li key={entry.id}>
                  {/* One row, read in one direction: the tick that takes the
                      file, the kind it is, a taste of it — the picture for
                      what has one, the words for what does not — and its
                      name. */}
                  <label className="asset-pick-row">
                    <input
                      checked={chosen.includes(entry.id)}
                      className="asset-pick-tick"
                      data-testid={`asset-pick-${entry.id}`}
                      onChange={() => toggle(entry.id)}
                      type="checkbox"
                    />
                    <span
                      className={`asset-pick-kind is-${kind}`}
                      data-testid={`asset-pick-kind-${entry.id}`}
                    >
                      {CAPABILITY_LABELS[kind]}
                    </span>
                    {thumb ? (
                      <img alt="" className="asset-pick-thumb" src={thumb} />
                    ) : (
                      <span className="asset-pick-excerpt" title={excerpt}>
                        {excerpt || (
                          <span aria-hidden="true">
                            {shelf ? SHELF_GLYPHS[shelf] : "▪"}
                          </span>
                        )}
                      </span>
                    )}
                    <span className="asset-pick-name">{entry.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <footer className="asset-pick-foot">
          <p className="prompt-panel-note" data-testid="asset-pick-count">
            {count}
          </p>
          <button onClick={close} type="button">
            Cancel
          </button>
          <button
            className="primary"
            disabled={chosen.length === 0 || busy}
            onClick={() => void take()}
            type="button"
          >
            {busy ? "Working…" : ask.mode === "nodes" ? "Insert" : "Add"}
          </button>
        </footer>
      </div>
    </div>
  );
}
