import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetCategory,
  MokaFile,
  NodeId,
  ResourceEntry,
  WorkflowNode,
} from "../../../shared/domain";
import {
  ASSET_CATEGORY_LABELS,
  PROJECT_ASSET_CATEGORIES,
} from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { buildIssueIndex, formatBytes } from "../canvas/mediaCards";
import {
  ASSET_DRAG_MIME,
  assetReferencingNodeIds,
  editShelfEntry,
  fitSelectionAction,
  importFiles,
  markAssetKeeper,
  requestDeleteAsset,
} from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import {
  OPEN_SHELF_FILTER,
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

/** What a row shows when there is no picture of the file to show. */
const SHELF_GLYPHS: Record<AssetCategory, string> = {
  images: "▣",
  music: "♫",
  voice: "♪",
  texts: "¶",
  videos: "▶",
};

interface ImportJob {
  file: File;
  progress: number;
  status: "uploading" | "done" | "error";
}

/** Selects nodes by id, switching canvas when they are not on the active one. */
function focusNodes(nodeIds: NodeId[]) {
  const project = useProjectStore.getState();
  const active = project.moka?.canvas.find(
    (canvas) => canvas.id === project.activeCanvasId,
  );
  if (!active?.nodes.some((node) => nodeIds.includes(node.id))) {
    const holder = project.moka?.canvas.find((canvas) =>
      canvas.nodes.some((node) => nodeIds.includes(node.id)),
    );
    if (holder) project.switchCanvas(holder.id);
  }
  useEditorStore.getState().setSelection({ nodeIds, edgeIds: [] });
  fitSelectionAction();
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

/** Which shelf an asset sits on, read off the path it is stored at. */
function categoryOf(entry: ResourceEntry): AssetCategory | null {
  const category = entry.path.split("/")[1];
  return PROJECT_ASSET_CATEGORIES.find((shelf) => shelf === category) ?? null;
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
}: {
  entry: ResourceEntry;
  broken: boolean;
}) {
  const openPreview = useEditorStore((state) => state.openPreview);
  const moka = useProjectStore((state) => state.moka);
  const [editing, setEditing] = useState(false);
  const uses = assetReferencingNodeIds(entry.id).length;
  const maker = makerOf(moka, entry.provenance?.operationNodeId);
  const keeper = entry.favorite === true;
  const thumb = thumbOf(entry);
  const shelf = categoryOf(entry);
  const where = shelfWhere(entry);
  return (
    <li
      className="resource-row"
      draggable
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
  onChange,
}: {
  filter: ShelfFilter;
  words: { tag: string; count: number }[];
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
        <select
          aria-label="Which shelf"
          data-testid="shelf-category"
          onChange={(event) =>
            onChange({
              ...filter,
              category: (event.target.value || null) as ShelfFilter["category"],
            })
          }
          value={filter.category ?? ""}
        >
          <option value="">Every shelf</option>
          {PROJECT_ASSET_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {ASSET_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
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

function ResourcesSection() {
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [addNodes, setAddNodes] = useState(true);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [filter, setFilter] = useState<ShelfFilter>(OPEN_SHELF_FILTER);
  const [pages, setPages] = useState(1);
  const issues = useMemo(() => buildIssueIndex(selfCheck), [selfCheck]);
  const matched = useMemo(
    () => (moka ? filterShelf(moka.resources, filter) : []),
    [moka, filter],
  );
  const words = useMemo(() => (moka ? shelfTags(moka.resources) : []), [moka]);
  useEffect(() => setPages(1), [filter]);
  if (!moka) return null;

  const busy = jobs.some((job) => job.status === "uploading");
  const filed = Object.values(moka.resources).reduce(
    (total, entries) => total + entries.length,
    0,
  );
  const visible = matched.slice(0, pages * SHELF_PAGE);

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
        <h2>Resources</h2>
        <button
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          type="button"
        >
          Import…
        </button>
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
      <ShelfFilterBar filter={filter} onChange={setFilter} words={words} />
      {filed > 0 && visible.length === 0 && (
        <p className="inspector-empty" data-testid="shelf-no-match">
          Nothing on the shelf says that.
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
          No assets yet — import files or drop them on the canvas.
        </p>
      )}
    </section>
  );
}

export function SidePanel() {
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  if (!moka) return null;

  return (
    <aside aria-label="Project" className="editor-side">
      <section>
        <h2>Canvases</h2>
        <ul className="side-canvas-list">
          {moka.canvas.map((canvas) => (
            <li key={canvas.id}>
              <button
                className={canvas.id === activeCanvasId ? "is-active" : ""}
                onClick={() =>
                  useProjectStore.getState().switchCanvas(canvas.id)
                }
                type="button"
              >
                <strong>{canvas.name}</strong>
                <span>
                  {canvas.nodes.length} nodes · {canvas.edges.length} edges
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <ResourcesSection />
    </aside>
  );
}
