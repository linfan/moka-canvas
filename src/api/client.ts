import { CONFIGURATION_PROBLEM_CODES } from "../shared/domain/constants";
import type { ProblemCode } from "../shared/domain";
import { problemMessage, type ProblemValues } from "../shared/i18n/problems";

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
  /**
   * What the server said, as it said it.
   *
   * Kept beside the sentence this error shows: a Chinese interface reads the
   * catalogue's words, and the catalogue is the shorter of the two, so a
   * reader who wants the model id or the provider's own explanation is owed
   * the English the client was handed rather than only its translation.
   */
  readonly rawMessage: string;

  /**
   * `values` are the fields a Chinese message may read that the problem body
   * itself does not carry, as when a transport failure knows the reason under
   * it; they are used for interpolation alone and never stored.
   */
  constructor(problem: ProblemBody, values?: ProblemValues) {
    super(
      problemMessage(problem.code, problem.message, {
        ...problem.details,
        status: problem.status,
        ...values,
      }),
    );
    this.name = "ApiError";
    this.code = problem.code;
    this.status = problem.status;
    this.details = problem.details;
    this.rawMessage = problem.message;
  }

  /**
   * A failure that never reached the local process. `message` is the sentence
   * this layer has always shown; `cause` is the reason underneath it when the
   * transport gave one, which is the part a Chinese message finishes with.
   */
  static transport(message: string, cause?: string): ApiError {
    return new ApiError(
      { code: "TRANSPORT", message, status: 0 },
      cause === undefined ? undefined : { message: cause },
    );
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

/**
 * Whether a trouble a record names is one the reader repairs in Settings.
 *
 * Read off a code alone, since that is all a record of something that failed
 * carries: a piece of a story batch and a step of a run say what kind of
 * trouble they hit without an error object to be handed around.
 */
export function isConfigurationCode(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (CONFIGURATION_PROBLEM_CODES as readonly string[]).includes(code)
  );
}

/**
 * Whether the reader can fix this in Settings rather than by asking again.
 *
 * The troubles a second ask repeats verbatim: a model that is not there, one
 * that holds no key, a credential the provider refused, and a model that
 * cannot do what was asked of it. Everything else — a busy provider, a slow
 * one, a refusal of one particular request — is either worth another try or
 * worth reading before it is.
 */
export function isConfigurationTrouble(error: unknown): boolean {
  return isConfigurationCode(
    error instanceof ApiError ? error.code : undefined,
  );
}

/**
 * What to say about a failure that reached the client as an error.
 *
 * The sentence this client shows — the catalogue's words for a known code, the
 * server's own otherwise — and, when the catalogue said them instead of the
 * server, the server's words as the detail: a reader who wants the model id or
 * the provider's explanation can then be given it without being sent to an
 * interface in another language.
 */
export function errorText(error: unknown): {
  message: string;
  detail?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ApiError)) return { message };
  return error.rawMessage === message
    ? { message }
    : { message, detail: error.rawMessage };
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
    const cause = (error as Error).message;
    throw ApiError.transport(`Cannot reach the local process: ${cause}`, cause);
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

/**
 * The trouble a response names, or a plain status-code failure when it names
 * none. Exported for the few callers that bring their own response — a save
 * written whole — so they report trouble the way every other request does.
 */
export async function toApiError(response: Response): Promise<ApiError> {
  const problem = await readProblem(response);
  if (problem !== null) return problem;
  return new ApiError({
    code: "INTERNAL",
    message: `Request failed with status ${response.status}`,
    status: response.status,
  });
}

/**
 * The problem a response body names, when it names one.
 *
 * Read apart from the shape a request handler wants so a caller with its own
 * response — a stream whose frames are read by hand — can say the same trouble
 * the same way, rather than reporting a status code and losing the reason.
 */
export async function readProblem(
  response: Response,
): Promise<ApiError | null> {
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
    // No body to read, which leaves the status as the whole of what is known.
  }
  return null;
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
