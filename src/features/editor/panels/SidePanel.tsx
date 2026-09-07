import { useMemo, useRef, useState } from "react";
import type { AssetCategory, ResourceEntry } from "../../../shared/domain";
import { buildIssueIndex, formatBytes } from "../canvas/mediaCards";
import {
  ASSET_DRAG_MIME,
  assetReferencingNodeIds,
  fitSelectionAction,
  importFiles,
  requestDeleteAsset,
} from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

const CATEGORY_LABELS: Record<string, string> = {
  images: "Images",
  music: "Music",
  voice: "Voice",
  texts: "Texts",
  videos: "Videos",
};

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
  const project = useProjectStore.getState();
  const activeId = project.activeCanvasId;
  const onActive = project.moka?.canvas
    .find((canvas) => canvas.id === activeId)
    ?.nodes.some((node) => nodeIds.includes(node.id));
  if (!onActive) {
    const target = project.moka?.canvas.find((canvas) =>
      canvas.nodes.some((node) => nodeIds.includes(node.id)),
    );
    if (target) project.switchCanvas(target.id);
  }
  editor.setSelection({ nodeIds, edgeIds: [] });
  fitSelectionAction();
  editor.announce(
    `Selected ${nodeIds.length} node${nodeIds.length === 1 ? "" : "s"} using this asset`,
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
  const uses = assetReferencingNodeIds(entry.id).length;
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
    </li>
  );
}

function ResourcesSection() {
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [addNodes, setAddNodes] = useState(true);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const issues = useMemo(() => buildIssueIndex(selfCheck), [selfCheck]);
  if (!moka) return null;

  const busy = jobs.some((job) => job.status === "uploading");

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
      {(Object.entries(moka.resources) as [AssetCategory, ResourceEntry[]][])
        .filter(([, entries]) => entries.length > 0)
        .map(([category, entries]) => (
          <div className="side-resource-group" key={category}>
            <h3>
              {CATEGORY_LABELS[category] ?? category} · {entries.length}
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
      {Object.values(moka.resources).every((list) => list.length === 0) && (
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
