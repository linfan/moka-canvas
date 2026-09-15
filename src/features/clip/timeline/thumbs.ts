import { useSyncExternalStore } from "react";
import type { AssetId, ResourceRegistry } from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { useProjectStore } from "../../editor/stores/projectStore";

/**
 * The pictures the timeline draws on its clips, loaded once per asset.
 *
 * The canvas asks for an asset's picture and gets the loaded image or
 * nothing; a video answers with its poster frame, which is all there is to
 * show for it until 07 lays a filmstrip down. A picture arriving is the only
 * thing here that changes, so the version below is the whole subscription —
 * and a picture that will not load is asked for once, not once a frame.
 */
export interface ThumbCache {
  get(assetId: AssetId): HTMLImageElement | null;
}

const loaded = new Map<AssetId, HTMLImageElement>();
const started = new Set<AssetId>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Where an asset's picture lives: its own file, or the poster frame a video was probed with. */
function pictureOf(assetId: AssetId): AssetId {
  const resources: ResourceRegistry | undefined =
    useProjectStore.getState().moka?.resources;
  if (!resources) return assetId;
  for (const entries of Object.values(resources)) {
    const entry = entries.find((candidate) => candidate.id === assetId);
    if (entry?.probe?.posterAssetId) return entry.probe.posterAssetId;
  }
  return assetId;
}

function get(assetId: AssetId): HTMLImageElement | null {
  const kept = loaded.get(assetId);
  if (kept) return kept;
  // A test without a DOM never makes an image, the same way the shelf never
  // makes a sound in one.
  if (started.has(assetId) || typeof Image === "undefined") return null;
  started.add(assetId);
  const image = new Image();
  image.onload = () => {
    loaded.set(assetId, image);
    bump();
  };
  image.src = assetUrl(pictureOf(assetId));
  return null;
}

const cache: ThumbCache = { get };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cache, subscribed: a picture arriving redraws whoever asked. */
export function useThumbCache(): ThumbCache {
  useSyncExternalStore(subscribe, () => version);
  return cache;
}
