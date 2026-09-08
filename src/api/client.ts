import type { ProblemCode } from "../shared/domain";

export interface ProblemBody {
  code: ProblemCode | string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(problem: ProblemBody) {
    super(problem.message);
    this.name = "ApiError";
    this.code = problem.code;
    this.status = problem.status;
    this.details = problem.details;
  }

  static transport(message: string): ApiError {
    return new ApiError({ code: "TRANSPORT", message, status: 0 });
  }

  static parse(status: number): ApiError {
    return new ApiError({
      code: "PARSE",
      message: `The server returned an unreadable response (${status})`,
      status,
    });
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return (
    error instanceof ApiError && (code === undefined || error.code === code)
  );
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  onUploadProgress?: (fraction: number) => void;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";

  if (options.formData && options.onUploadProgress) {
    return requestWithProgress<T>(path, options.formData, options);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal: options.signal,
      // FormData sets its own multipart boundary header.
      headers:
        options.body !== undefined && !options.formData
          ? { "Content-Type": "application/json" }
          : undefined,
      body: options.formData
        ? options.formData
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw ApiError.transport(
      `Cannot reach the local process: ${(error as Error).message}`,
    );
  }

  if (!response.ok) {
    throw await toApiError(response);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw ApiError.parse(response.status);
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const problem = (await response.json()) as Partial<ProblemBody>;
    if (
      typeof problem.code === "string" &&
      typeof problem.message === "string"
    ) {
      return new ApiError({
        code: problem.code,
        message: problem.message,
        status: response.status,
        details: problem.details,
      });
    }
  } catch {
    // fall through to the generic status error
  }
  return new ApiError({
    code: "INTERNAL",
    message: `Request failed with status ${response.status}`,
    status: response.status,
  });
}

function requestWithProgress<T>(
  path: string,
  formData: FormData,
  options: RequestOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? "POST", path);
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && options.onUploadProgress) {
        options.onUploadProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(ApiError.parse(xhr.status));
        }
        return;
      }
      try {
        const problem = JSON.parse(xhr.responseText) as ProblemBody;
        reject(new ApiError({ ...problem, status: xhr.status }));
      } catch {
        reject(
          new ApiError({
            code: "INTERNAL",
            message: `Request failed with status ${xhr.status}`,
            status: xhr.status,
          }),
        );
      }
    };
    xhr.onerror = () =>
      reject(ApiError.transport("Cannot reach the local process"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    if (options.signal) {
      options.signal.addEventListener("abort", () => xhr.abort(), {
        once: true,
      });
    }
    xhr.send(formData);
  });
}

export const http = { request };
