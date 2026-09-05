import type {
  DocumentCommand,
  MokaFile,
  SelfCheckReport,
} from "../shared/domain";
import { http } from "./client";

export interface OpenProjectResult {
  root: string;
  moka: MokaFile;
  selfCheck: SelfCheckReport;
}

export interface SaveResult {
  revision: number;
  updatedAt: string;
}

export interface RecentProject {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
}

export interface PackageReport {
  destination: string;
  entries: number;
  bytes: number;
  incomplete: boolean;
}

export interface ExportOptions {
  destination?: string;
  allowIncomplete?: boolean;
}

export const projectsApi = {
  create(directory: string, name: string): Promise<OpenProjectResult> {
    return http.request<OpenProjectResult>("/api/v1/projects", {
      method: "POST",
      body: { directory, name },
    });
  },

  open(path: string): Promise<OpenProjectResult> {
    return http.request<OpenProjectResult>("/api/v1/projects/open", {
      method: "POST",
      body: { path },
    });
  },

  current(signal?: AbortSignal): Promise<OpenProjectResult> {
    return http.request<OpenProjectResult>("/api/v1/projects/current", {
      signal,
    });
  },

  applyCommands(
    expectedRevision: number,
    commands: DocumentCommand[],
    signal?: AbortSignal,
  ): Promise<SaveResult> {
    return http.request<SaveResult>("/api/v1/projects/current/commands", {
      method: "POST",
      body: { expectedRevision, commands },
      signal,
    });
  },

  exportPackage(options: ExportOptions = {}): Promise<PackageReport> {
    return http.request<PackageReport>("/api/v1/projects/current/export", {
      method: "POST",
      body: options,
    });
  },

  importFromPath(
    archivePath: string,
    directory: string,
    name?: string,
  ): Promise<OpenProjectResult> {
    return http.request<OpenProjectResult>("/api/v1/projects/import", {
      method: "POST",
      body: { archivePath, directory, name },
    });
  },

  importUpload(
    file: File,
    directory: string,
    name?: string,
    onUploadProgress?: (fraction: number) => void,
  ): Promise<OpenProjectResult> {
    const formData = new FormData();
    formData.set("directory", directory);
    if (name) formData.set("name", name);
    formData.set("file", file, file.name);
    return http.request<OpenProjectResult>("/api/v1/projects/import", {
      method: "POST",
      formData,
      onUploadProgress,
    });
  },
};

export const recentApi = {
  list(signal?: AbortSignal): Promise<RecentProject[]> {
    return http.request<RecentProject[]>("/api/v1/recent-projects", { signal });
  },

  remove(id: string): Promise<void> {
    return http.request<void>(`/api/v1/recent-projects/${id}`, {
      method: "DELETE",
    });
  },
};
