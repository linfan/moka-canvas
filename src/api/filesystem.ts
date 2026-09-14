import { http } from "./client";

/** One row of a listing: a name, where it leads, and which of the two it is. */
export interface FilesystemEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

/** What one directory holds, as the server answered it. */
export interface FilesystemListing {
  /** The directory listed, resolved — not necessarily the one asked for. */
  path: string;
  /** Where up leads, and null at the top of a filesystem. */
  parent: string | null;
  entries: FilesystemEntry[];
  /** Whether the listing stopped before the directory was exhausted. */
  truncated: boolean;
}

/**
 * What a directory holds, for a runtime with no file dialog of its own.
 *
 * A desktop asks the operating system which folder is meant; a browser cannot
 * ask anything, and this is what stands in for the question there. It is served
 * only in the web runtime, so a caller has to be ready for the route to say it
 * is not there — which is the same answer the desktop's own dialog gives when
 * it is not offered at all.
 *
 * A listing carries the folders in a directory and the files whose extension
 * was asked for, and nothing about what any of them holds. Asking for no
 * extensions at all asks for the folders alone, which is the question a place
 * to put a new project is.
 */
export const filesystemApi = {
  list(path?: string, extensions?: string[]): Promise<FilesystemListing> {
    const asked = new URLSearchParams();
    const where = path?.trim();
    if (where) asked.set("path", where);
    if (extensions && extensions.length > 0) {
      asked.set("extensions", extensions.join(","));
    }
    const query = asked.toString();
    return http.request<FilesystemListing>(
      `/api/v1/filesystem${query === "" ? "" : `?${query}`}`,
    );
  },
};
