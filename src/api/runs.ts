import type {
  CanvasId,
  NodeId,
  RunId,
  RunRecord,
  RunStatus,
} from "../shared/domain";
import { http } from "./client";

/** Words a run said about one of its nodes as they arrived. */
export interface RunWords {
  nodeId: NodeId;
  /** The slot the words are going to land in. */
  slotId: string;
  text: string;
}

/** What a listener is told, and what to do when the stream stops being one. */
export interface RunListener {
  onWords?: (words: RunWords) => void;
  onEnded: (status: RunStatus) => void;
  /**
   * The stream broke, or there was never a way to hold one open.
   *
   * Nothing was lost but the shortcut. The record is still where the truth is,
   * and a caller that hears this asks for it the way it always did.
   */
  onBroken?: () => void;
}

/**
 * Follows what a run says while it is going, and returns the way to stop.
 *
 * A display's shortcut to the record rather than a source of anything: the
 * closing frame says the run is over and the caller reads the record next,
 * which is the only thing that decides what happened.
 */
function follow(id: RunId, listener: RunListener): () => void {
  // A platform that cannot hold a stream open is not broken, it is a reason to
  // keep asking for the record instead.
  if (typeof EventSource === "undefined") {
    listener.onBroken?.();
    return () => {};
  }

  const source = new EventSource(
    `/api/v1/generate/stream?runId=${encodeURIComponent(id)}`,
  );
  const stop = () => source.close();

  const hear = (kind: string, handler: (event: MessageEvent<string>) => void) =>
    source.addEventListener(kind, handler as EventListener);

  hear("delta", (event) => {
    const { nodeId, slotId, text } = JSON.parse(event.data) as RunWords;
    listener.onWords?.({ nodeId, slotId, text });
  });
  hear("done", (event) => {
    const { status } = JSON.parse(event.data) as { status: RunStatus };
    stop();
    listener.onEnded(status);
  });
  // Closed rather than left to reconnect, because a stream that broke is a
  // reason to fall back on the record rather than to keep reopening a door
  // that has just shut.
  source.onerror = () => {
    stop();
    listener.onBroken?.();
  };

  return stop;
}

export const runsApi = {
  list(signal?: AbortSignal): Promise<RunRecord[]> {
    return http.request<RunRecord[]>("/api/v1/projects/current/runs", {
      signal,
    });
  },

  get(id: RunId, signal?: AbortSignal): Promise<RunRecord> {
    return http.request<RunRecord>(`/api/v1/projects/current/runs/${id}`, {
      signal,
    });
  },

  start(canvasId: CanvasId, nodeIds: NodeId[]): Promise<RunRecord> {
    return http.request<RunRecord>("/api/v1/projects/current/runs", {
      method: "POST",
      body: { canvasId, nodeIds },
    });
  },

  cancel(id: RunId): Promise<RunRecord> {
    return http.request<RunRecord>(
      `/api/v1/projects/current/runs/${id}/cancel`,
      { method: "POST" },
    );
  },

  retry(id: RunId): Promise<RunRecord> {
    return http.request<RunRecord>(
      `/api/v1/projects/current/runs/${id}/retry`,
      { method: "POST" },
    );
  },

  follow,
};
