import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetCategory,
  Capability,
  MokaFile,
  NodeId,
  ResourceEntry,
  WorkflowNode,
} from "../../../shared/domain";
import {
  ASSET_CATEGORY_LABELS,
  CAPABILITY_LABELS,
  PROJECT_ASSET_CATEGORIES,
} from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { buildIssueIndex, formatBytes } from "../canvas/mediaCards";
import {
  ASSET_DRAG_MIME,
  assetReferencingNodeIds,
  editShelfEntry,
  focusNodes,
  importFiles,
  markAssetKeeper,
  requestDeleteAsset,
} from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { shelfOf } from "./canvasAssets";
import {
  KIND_SHELVES,
  OPEN_SHELF_FILTER,
  SHELF_KINDS,
  SHELF_GLYPHS,
  SHELF_PAGE,
  SHELF_WHERE_LABELS,
  filterShelf,
  groupShelf,
  shelfFilterIsOpen,
  shelfTags,
  shelfWhere,
  type ShelfFilter,
  type ShelfWhere,
} from "./shelfFilter";

/**
 * What the project is made of, one kind at a time.
 *
 * The shelf this column used to show whole, cut into the four kinds of thing a
 * board can be given, since a reader looking for a picture is not looking for
 * the words beside it. What a file carries about itself — the words it is filed
 * under, the note, the keeper mark, where it came from — is all still here, and
 * a file can still be dragged onto the canvas to become a card.
 */

interface ImportJob {
  file: File;
  progress: number;
  status: "uploading" | "done" | "error";
}

/** Selects every node referencing the asset, switching canvas if needed. */
function focusAssetReferences(assetId: string) {
  const nodeIds = assetReferencingNodeIds(assetId);
  const editor = useEditorStore.getState();
  if (nodeIds.length === 0) {
    editor.announce("No nodes reference this asset");
    return;
  }
  focusNodes(nodeIds);
  editor.announce(
    `Selected ${nodeIds.length} node${nodeIds.length === 1 ? "" : "s"} using this asset`,
  );
}

/** Selects the node a generated asset came from, wherever it sits. */
function focusGeneratingNode(nodeId: NodeId) {
  focusNodes([nodeId]);
  useEditorStore.getState().announce("Selected the node that made this asset");
}

/** The node that made an asset, on whichever canvas it is. */
function makerOf(moka: MokaFile | null, nodeId?: NodeId): WorkflowNode | null {
  if (!moka || !nodeId) return null;
  for (const canvas of moka.canvas) {
    const maker = canvas.nodes.find((node) => node.id === nodeId);
    if (maker) return maker;
  }
  return null;
}

/** The picture a row leads with, when the file has one to show. */
function thumbOf(entry: ResourceEntry): string | null {
  if (entry.mime === "image/png" || entry.mime === "image/jpeg") {
    return assetUrl(entry.id);
  }
  const poster = entry.probe?.posterAssetId;
  return entry.mime === "video/mp4" && poster ? assetUrl(poster) : null;
}

/**
 * The words an entry is filed under and whatever was noted about it, offered
 * right on the row. Only the registry entry is written, so adding a word costs
 * nothing of the file it names.
 */
function ShelfEditor({
  entry,
  onDone,
}: {
  entry: ResourceEntry;
  onDone: () => void;
}) {
  const [tags, setTags] = useState(() => (entry.tags ?? []).join(", "));
  const [note, setNote] = useState(entry.note ?? "");
  return (
    <form
      className="resource-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const words = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        void editShelfEntry(entry, {
          tags: [...new Set(words)],
          note: note.trim(),
        });
        onDone();
      }}
    >
      <input
        aria-label={`Words to file ${entry.name} under`}
        className="resource-editor-tags"
        onChange={(event) => setTags(event.target.value)}
        placeholder="Words, comma separated"
        value={tags}
      />
      <textarea
        aria-label={`Note about ${entry.name}`}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What is worth remembering"
        rows={2}
        value={note}
      />
      <div className="resource-editor-actions">
        <button type="submit">Save</button>
        <button onClick={onDone} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ResourceRow({
  entry,
  broken,
  focused,
}: {
  entry: ResourceEntry;
  broken: boolean;
  /** Whether a reader was just brought to this row from somewhere else. */
  focused: boolean;
}) {
  const openPreview = useEditorStore((state) => state.openPreview);
  const moka = useProjectStore((state) => state.moka);
  const [editing, setEditing] = useState(false);
  const rowRef = useRef<HTMLLIElement | null>(null);
  // Followed here from the tree, which is a row among however many: brought
  // into view rather than left to be found somewhere below the fold. Asked of
  // the platform rather than assumed of it, since a column that cannot scroll
  // still marks the row a reader was taken to.
  useEffect(() => {
    const row = rowRef.current;
    if (focused && row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);
  const uses = assetReferencingNodeIds(entry.id).length;
  const maker = makerOf(moka, entry.provenance?.operationNodeId);
  const keeper = entry.favorite === true;
  const thumb = thumbOf(entry);
  const shelf = shelfOf(entry);
  const where = shelfWhere(entry);
  return (
    <li
      className={`resource-row${focused ? " is-focused" : ""}`}
      data-asset-id={entry.id}
      draggable
      ref={rowRef}
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DRAG_MIME, entry.id);
        event.dataTransfer.effectAllowed = "copy";
      }}
      title={entry.path}
    >
      <span className="resource-thumb" data-testid="resource-thumb">
        {thumb ? (
          <img alt="" src={thumb} />
        ) : (
          <span aria-hidden="true">{shelf ? SHELF_GLYPHS[shelf] : "▪"}</span>
        )}
      </span>
      <button
        className="resource-main"
        onClick={() => focusAssetReferences(entry.id)}
        type="button"
      >
        <strong>{entry.name}</strong>
        <span>
          {broken ? "⚠ broken · " : ""}
          {formatBytes(entry.bytes)}
          {uses > 0 ? ` · ${uses} use${uses === 1 ? "" : "s"}` : ""}
        </span>
      </button>
      <span className="resource-actions">
        <button
          aria-label={`${keeper ? "Stop keeping" : "Keep"} ${entry.name} to hand`}
          aria-pressed={keeper}
          className={`resource-action keeper${keeper ? " is-active" : ""}`}
          onClick={() => void markAssetKeeper(entry, !keeper)}
          title={keeper ? "Kept to hand" : "Not kept to hand"}
          type="button"
        >
          ★
        </button>
        <button
          aria-label={`Tag ${entry.name}`}
          aria-pressed={editing}
          className={`resource-action${editing ? " is-active" : ""}`}
          onClick={() => setEditing((current) => !current)}
          title="Words and notes"
          type="button"
        >
          Tag
        </button>
        <button
          aria-label={`Preview ${entry.name}`}
          className="resource-action"
          onClick={() => openPreview(entry.id)}
          type="button"
        >
          View
        </button>
        <button
          aria-label={`Delete ${entry.name}`}
          className="resource-action danger"
          onClick={() => void requestDeleteAsset(entry.id)}
          type="button"
        >
          ✕
        </button>
      </span>
      <span className="resource-said">
        <span className="resource-where" data-testid="resource-where">
          {SHELF_WHERE_LABELS[where]}
        </span>
        {entry.tags?.map((tag) => (
          <span className="resource-tag" key={tag}>
            {tag}
          </span>
        ))}
        {maker && (
          <button
            aria-label={`Go to ${maker.title}, which made ${entry.name}`}
            className="resource-origin"
            onClick={() => focusGeneratingNode(maker.id)}
            title={`Made by ${maker.title}`}
            type="button"
          >
            Made by {maker.title}
          </button>
        )}
      </span>
      {editing && (
        <ShelfEditor entry={entry} onDone={() => setEditing(false)} />
      )}
    </li>
  );
}

function ShelfFilterBar({
  filter,
  words,
  shelves,
  onChange,
}: {
  filter: ShelfFilter;
  words: { tag: string; count: number }[];
  /** The shelves the kind being read is filed on, which is one for most kinds. */
  shelves: readonly AssetCategory[];
  onChange: (next: ShelfFilter) => void;
}) {
  return (
    <div className="side-shelf-filter">
      <input
        aria-label="Search the shelf"
        className="side-shelf-asked"
        data-testid="shelf-asked"
        onChange={(event) => onChange({ ...filter, asked: event.target.value })}
        placeholder="Name, word, note, or summary"
        type="search"
        value={filter.asked}
      />
      <div className="side-shelf-row">
        {/*
          Offered only where the kind has more than one shelf to tell apart:
          a sound is filed as either music or a voice, and a reader after one
          of them has a reason to say so. A kind filed on one shelf would be
          asking a question with one answer.
        */}
        {shelves.length > 1 && (
          <select
            aria-label="Which shelf"
            data-testid="shelf-category"
            onChange={(event) =>
              onChange({
                ...filter,
                category: (event.target.value ||
                  null) as ShelfFilter["category"],
              })
            }
            value={filter.category ?? ""}
          >
            <option value="">Every shelf</option>
            {shelves.map((category) => (
              <option key={category} value={category}>
                {ASSET_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Where it came from"
          data-testid="shelf-where"
          onChange={(event) =>
            onChange({
              ...filter,
              where: (event.target.value || null) as ShelfWhere | null,
            })
          }
          value={filter.where ?? ""}
        >
          <option value="">Any origin</option>
          {(Object.keys(SHELF_WHERE_LABELS) as ShelfWhere[]).map((where) => (
            <option key={where} value={where}>
              {SHELF_WHERE_LABELS[where]}
            </option>
          ))}
        </select>
        <label className="side-shelf-keeper">
          <input
            checked={filter.keepersOnly}
            data-testid="shelf-keepers"
            onChange={(event) =>
              onChange({ ...filter, keepersOnly: event.target.checked })
            }
            type="checkbox"
          />
          Keepers only
        </label>
        {!shelfFilterIsOpen(filter) && (
          <button
            data-testid="shelf-clear"
            onClick={() => onChange(OPEN_SHELF_FILTER)}
            type="button"
          >
            Clear
          </button>
        )}
      </div>
      {words.length > 0 && (
        <div aria-label="Filed under" className="side-shelf-tags" role="group">
          {words.map(({ count, tag }) => (
            <button
              aria-pressed={filter.tags.includes(tag)}
              className={`side-shelf-tag${
                filter.tags.includes(tag) ? " is-active" : ""
              }`}
              data-testid={`shelf-tag-${tag}`}
              key={tag}
              onClick={() =>
                onChange({
                  ...filter,
                  tags: filter.tags.includes(tag)
                    ? filter.tags.filter((seen) => seen !== tag)
                    : [...filter.tags, tag],
                })
              }
              type="button"
            >
              {tag} · {count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * How many files a kind holds, for the tab that reads them.
 *
 * Counted over the whole of that kind rather than over what a filter left
 * standing, so a tab says what it has and not what is currently being asked of
 * it: a reader who narrowed the pictures to nothing still needs to know there
 * are pictures to narrow.
 */
function kindCount(moka: MokaFile, kind: Capability): number {
  return KIND_SHELVES[kind].reduce(
    (total, shelf) => total + (moka.resources[shelf]?.length ?? 0),
    0,
  );
}

/** The shelves a kind is filed on, holding nothing but what is on them. */
function narrowed(
  moka: MokaFile,
  kind: Capability,
): { resources: MokaFile["resources"]; shelves: readonly AssetCategory[] } {
  const shelves = KIND_SHELVES[kind];
  const resources = Object.fromEntries(
    PROJECT_ASSET_CATEGORIES.map((category) => [
      category,
      shelves.includes(category) ? (moka.resources[category] ?? []) : [],
    ]),
  ) as MokaFile["resources"];
  return { resources, shelves };
}

export function AssetsPanel() {
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const kind = useEditorStore((state) => state.assetKind);
  const focusedAssetId = useEditorStore((state) => state.focusedAssetId);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [addNodes, setAddNodes] = useState(true);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [filter, setFilter] = useState<ShelfFilter>(OPEN_SHELF_FILTER);
  const [pages, setPages] = useState(1);

  const issues = useMemo(() => buildIssueIndex(selfCheck), [selfCheck]);
  const { resources, shelves } = useMemo(
    () =>
      moka
        ? narrowed(moka, kind)
        : { resources: null, shelves: KIND_SHELVES[kind] },
    [moka, kind],
  );
  const matched = useMemo(
    () => (resources ? filterShelf(resources, filter) : []),
    [resources, filter],
  );
  // Counted over the kind being read, so a word offered beside it is a word
  // that narrows this list rather than one that would empty it.
  const words = useMemo(
    () => (resources ? shelfTags(resources) : []),
    [resources],
  );
  useEffect(() => setPages(1), [filter, kind]);

  /**
   * Brings an asset followed here from the tree into view.
   *
   * Whatever was being asked of the shelf is let go of first: a row hidden by a
   * search is a row that cannot be scrolled to, and a reader who followed an
   * asset here is asking to see that asset rather than to keep a narrowing they
   * made for something else. The mark is taken off again a moment later, since a
   * row that stays lit forever is a row nobody reads as the one arrived at.
   */
  useEffect(() => {
    if (!focusedAssetId) return;
    setFilter(OPEN_SHELF_FILTER);
    const held = useProjectStore.getState().moka;
    if (held) {
      const all = KIND_SHELVES[kind].flatMap(
        (shelf) => held.resources[shelf] ?? [],
      );
      const at = all.findIndex((entry) => entry.id === focusedAssetId);
      if (at >= 0) setPages(Math.ceil((at + 1) / SHELF_PAGE));
    }
    const timer = setTimeout(
      () => useEditorStore.getState().clearAssetFocus(),
      2_500,
    );
    return () => clearTimeout(timer);
  }, [focusedAssetId, kind]);

  if (!moka || !resources) return null;

  const busy = jobs.some((job) => job.status === "uploading");
  const filed = kindCount(moka, kind);
  const visible = matched.slice(0, pages * SHELF_PAGE);
  const focused = focusedAssetId ?? null;

  const startImport = async (files: File[]) => {
    if (files.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setJobs(files.map((file) => ({ file, progress: 0, status: "uploading" })));
    await importFiles(files, {
      addNodes,
      signal: controller.signal,
      onFileProgress: (index, fraction) =>
        setJobs((current) =>
          current.map((job, i) =>
            i === index ? { ...job, progress: fraction } : job,
          ),
        ),
      onFileDone: (index, error) =>
        setJobs((current) =>
          current.map((job, i) =>
            i === index
              ? { ...job, progress: 1, status: error ? "error" : "done" }
              : job,
          ),
        ),
    });
    abortRef.current = null;
    setJobs((current) => {
      if (controller.signal.aborted) {
        return current.map((job) =>
          job.status === "uploading" ? { ...job, status: "error" } : job,
        );
      }
      return current.some((job) => job.status === "error") ? current : [];
    });
  };

  const retryJob = (index: number) => {
    const job = jobs[index];
    if (!job) return;
    setJobs([]);
    void startImport([job.file]);
  };

  return (
    <section className="side-resources">
      <div className="side-resources-head">
        <h2>Assets</h2>
        <button
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          type="button"
        >
          Import…
        </button>
      </div>
      <div aria-label="Add to" className="side-asset-kinds" role="tablist">
        {SHELF_KINDS.map((each) => (
          <button
            aria-selected={each === kind}
            className={each === kind ? "is-active" : ""}
            data-testid={`asset-kind-${each}`}
            key={each}
            onClick={() => useEditorStore.getState().setAssetKind(each)}
            role="tab"
            title={`Add to a ${CAPABILITY_LABELS[each].toLowerCase()} node`}
            type="button"
          >
            {CAPABILITY_LABELS[each]}
            <span>{kindCount(moka, each)}</span>
          </button>
        ))}
      </div>
      <label className="side-add-nodes">
        <input
          checked={addNodes}
          onChange={(event) => setAddNodes(event.target.checked)}
          type="checkbox"
        />
        Add nodes after import
      </label>
      <input
        aria-label="Import files"
        hidden
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void startImport(files);
        }}
        ref={fileInput}
        type="file"
      />
      {jobs.length > 0 && (
        <ul className="side-import-jobs">
          {jobs.map((job, index) => (
            <li key={`${job.file.name}-${index}`}>
              <span className="side-import-name">{job.file.name}</span>
              {job.status === "uploading" ? (
                <>
                  <progress max={1} value={job.progress} />
                  <button
                    aria-label="Cancel import"
                    onClick={() => abortRef.current?.abort()}
                    type="button"
                  >
                    ✕
                  </button>
                </>
              ) : job.status === "error" ? (
                <>
                  <span className="side-import-error">Failed</span>
                  <button onClick={() => retryJob(index)} type="button">
                    Retry
                  </button>
                </>
              ) : (
                <span>Done</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <ShelfFilterBar
        filter={filter}
        onChange={setFilter}
        shelves={shelves}
        words={words}
      />
      {filed > 0 && visible.length === 0 && (
        <p className="inspector-empty" data-testid="shelf-no-match">
          Nothing on this shelf says that.
        </p>
      )}
      {groupShelf(visible).map(({ category, entries }) => (
        <div className="side-resource-group" key={category}>
          <h3>
            {ASSET_CATEGORY_LABELS[category]} · {entries.length}
          </h3>
          <ul className="side-resource-list">
            {entries.map((entry) => (
              <ResourceRow
                broken={issues.has(entry.id)}
                entry={entry}
                focused={focused === entry.id}
                key={entry.id}
              />
            ))}
          </ul>
        </div>
      ))}
      {matched.length > visible.length && (
        <div className="side-shelf-paging">
          <span data-testid="shelf-shown">
            {visible.length} of {matched.length}
          </span>
          <button
            onClick={() => setPages((current) => current + 1)}
            type="button"
          >
            Show {Math.min(SHELF_PAGE, matched.length - visible.length)} more
          </button>
        </div>
      )}
      {filed === 0 && (
        <p className="inspector-empty">
          No {CAPABILITY_LABELS[kind].toLowerCase()} assets yet — import files
          or drop them on the canvas.
        </p>
      )}
    </section>
  );
}
