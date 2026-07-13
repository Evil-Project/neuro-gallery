import { API_HEADERS, API_ROUTES } from "../apiContract";
import {
  MAX_DELETE_IMAGE_IDS_PER_REQUEST,
  MAX_DIRECT_UPLOAD_TOTAL_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
} from "../uploadLimits";
import type {
  AuthSessionResponse,
  DeleteImagesResponse,
  GalleryImage,
  ImagesResponse,
  MultipartUploadCompleteResponse,
  MultipartUploadPartResponse,
  MultipartUploadStartResponse,
  RandomResponse,
  UploadResponse,
} from "./types";

const UPLOAD_RETRY_COUNT = 5;
const RETRY_BASE_DELAY_MS = 350;
const MAX_RETRY_AFTER_MS = 2 * 60 * 1000;
const MULTIPART_UPLOAD_CONCURRENCY = 3;
const RETRYABLE_UPLOAD_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface UploadProgress {
  fileIndex: number;
  fileCount: number;
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
}

export class UploadBatchError extends Error {
  constructor(
    message: string,
    readonly uploaded: GalleryImage[],
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "UploadBatchError";
  }
}

export class DeleteBatchError extends Error {
  constructor(
    message: string,
    readonly deleted: string[],
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "DeleteBatchError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    throw new ApiError(errorMessage(response, payload, text), response.status, parseRetryAfter(response.headers.get("retry-after")));
  }

  if (payload === null) {
    throw new TypeError("The server returned an invalid JSON response.");
  }

  return payload as T;
}

async function requestUploadJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= UPLOAD_RETRY_COUNT; attempt += 1) {
    if (init?.signal?.aborted) {
      throw new DOMException("Upload canceled.", "AbortError");
    }

    try {
      return await requestJson<T>(input, init);
    } catch (error) {
      lastError = error;

      if (attempt === UPLOAD_RETRY_COUNT || !isRetryableUploadError(error)) {
        throw error;
      }

      await delay(retryDelay(attempt, error), init?.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Upload failed.");
}

function parseJson(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(response: Response, payload: unknown, text: string): string {
  if (isErrorPayload(payload)) {
    return payload.error;
  }

  if (response.status === 413) {
    return "The upload was rejected before the app could process it. Try uploading fewer or smaller files in one request.";
  }

  const plainText = text.trim();

  if (plainText && !plainText.startsWith("<")) {
    return plainText;
  }

  return `Request failed with status ${response.status}`;
}

function isErrorPayload(payload: unknown): payload is { error: string } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.length > 0
  );
}

function isRetryableUploadError(error: unknown) {
  if (error instanceof ApiError) {
    return RETRYABLE_UPLOAD_STATUSES.has(error.status);
  }

  return error instanceof TypeError;
}

function retryDelay(attempt: number, error: unknown) {
  if (error instanceof ApiError && error.retryAfterMs !== null) {
    return error.retryAfterMs + Math.random() * Math.min(1_000, error.retryAfterMs * 0.1);
  }

  const exponentialDelay = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return exponentialDelay * (0.75 + Math.random() * 0.5);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS) : null;
}

function delay(milliseconds: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload canceled.", "AbortError"));
      return;
    }

    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Upload canceled.", "AbortError"));
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function fetchImages(cache: RequestCache = "default"): Promise<GalleryImage[]> {
  const payload = await requestJson<ImagesResponse>(API_ROUTES.images, { cache });
  return payload.images;
}

export async function uploadImages(files: File[], onProgress?: (progress: UploadProgress) => void): Promise<GalleryImage[]> {
  const uploaded: GalleryImage[] = [];

  for (const file of files) {
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      throw new Error(`${file.name} is larger than 100 MB.`);
    }
  }

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const progressBase = {
      fileIndex: index,
      fileCount: files.length,
      fileName: file.name,
      totalBytes: file.size,
    };

    try {
      if (file.size > MAX_DIRECT_UPLOAD_TOTAL_BYTES) {
        uploaded.push(await uploadLargeImage(file, (uploadedBytes) => onProgress?.({ ...progressBase, uploadedBytes })));
        continue;
      }

      const image = await uploadSingleImage(file);
      uploaded.push(image);
      onProgress?.({ ...progressBase, uploadedBytes: file.size });
    } catch (error) {
      if (uploaded.length > 0) {
        const message = error instanceof Error ? error.message : "Upload failed.";
        throw new UploadBatchError(
          `${uploaded.length} file${uploaded.length === 1 ? "" : "s"} uploaded before the failure: ${message}`,
          uploaded,
          error,
        );
      }

      throw error;
    }
  }

  return uploaded;
}

async function uploadSingleImage(file: File): Promise<GalleryImage> {
  const body = new FormData();
  const uploadId = crypto.randomUUID();

  body.append("images", file);

  const payload = await requestUploadJson<UploadResponse>(API_ROUTES.images, {
    method: "POST",
    body,
    credentials: "same-origin",
    headers: {
      [API_HEADERS.uploadId]: uploadId,
    },
  });

  const image = payload.uploaded[0];

  if (!image) {
    throw new Error("Upload completed without an image record.");
  }

  return image;
}

async function uploadLargeImage(file: File, onProgress?: (uploadedBytes: number) => void): Promise<GalleryImage> {
  let upload: MultipartUploadStartResponse | null = null;
  const clientUploadId = crypto.randomUUID();

  try {
    upload = await requestUploadJson<MultipartUploadStartResponse>(API_ROUTES.multipartUploads, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        [API_HEADERS.uploadId]: clientUploadId,
      },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type,
      }),
    });

    const totalParts = Math.ceil(file.size / upload.partSize);
    const parts: MultipartUploadPartResponse["part"][] = Array(totalParts);
    let nextPartIndex = 0;
    let uploadedBytes = 0;
    let uploadFailure: unknown = null;
    const partAbortController = new AbortController();
    const uploadPartWorker = async () => {
      while (uploadFailure === null && nextPartIndex < totalParts) {
        const index = nextPartIndex;
        nextPartIndex += 1;
        const partNumber = index + 1;
        const start = index * upload!.partSize;
        const end = Math.min(start + upload!.partSize, file.size);
        const chunk = file.slice(start, end);

        try {
          parts[index] = await uploadMultipartPart(upload!, partNumber, chunk, partAbortController.signal);
          uploadedBytes += chunk.size;

          if (uploadFailure === null) {
            onProgress?.(uploadedBytes);
          }
        } catch (error) {
          if (uploadFailure === null) {
            uploadFailure = error;
            partAbortController.abort();
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(MULTIPART_UPLOAD_CONCURRENCY, totalParts) }, uploadPartWorker));

    if (uploadFailure !== null) {
      throw uploadFailure;
    }

    const completed = await requestUploadJson<MultipartUploadCompleteResponse>(
      API_ROUTES.multipartComplete(upload.id),
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          uploadId: upload.uploadId,
          parts,
        }),
      },
    );

    return completed.image;
  } catch (error) {
    if (upload) {
      await abortMultipartUpload(upload).catch(() => undefined);
    }

    throw error;
  }
}

async function uploadMultipartPart(
  upload: MultipartUploadStartResponse,
  partNumber: number,
  chunk: Blob,
  signal: AbortSignal,
): Promise<MultipartUploadPartResponse["part"]> {
  const payload = await requestUploadJson<MultipartUploadPartResponse>(
    `${API_ROUTES.multipartPart(upload.id, partNumber)}?uploadId=${encodeURIComponent(upload.uploadId)}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: chunk,
      signal,
    },
  );

  return payload.part;
}

async function abortMultipartUpload(upload: MultipartUploadStartResponse): Promise<void> {
  await requestJson<{ ok: boolean }>(
    `${API_ROUTES.multipartUpload(upload.id)}?uploadId=${encodeURIComponent(upload.uploadId)}`,
    {
      method: "DELETE",
      credentials: "same-origin",
    },
  );
}

export async function fetchRandomImage(): Promise<GalleryImage> {
  const payload = await requestJson<RandomResponse>(`${API_ROUTES.random}?format=json`);
  return payload.image;
}

export async function deleteImage(id: string): Promise<void> {
  await requestUploadJson<{ ok: boolean }>(API_ROUTES.image(id), {
    method: "DELETE",
    credentials: "same-origin",
  });
}

export async function deleteImages(ids: string[]): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }

  const deleted: string[] = [];

  for (let index = 0; index < ids.length; index += MAX_DELETE_IMAGE_IDS_PER_REQUEST) {
    const batchIds = ids.slice(index, index + MAX_DELETE_IMAGE_IDS_PER_REQUEST);

    try {
      await requestUploadJson<DeleteImagesResponse>(API_ROUTES.images, {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ ids: batchIds }),
      });

      deleted.push(...batchIds);
    } catch (error) {
      if (deleted.length > 0) {
        const message = error instanceof Error ? error.message : "Delete failed.";
        throw new DeleteBatchError(
          `${deleted.length} image${deleted.length === 1 ? "" : "s"} deleted before the failure: ${message}`,
          deleted,
          error,
        );
      }

      throw error;
    }
  }

  return deleted;
}

export async function fetchAuthSession(): Promise<boolean> {
  const payload = await requestJson<AuthSessionResponse>(API_ROUTES.authSession, {
    credentials: "same-origin",
  });
  return payload.authenticated;
}

export async function login(password: string): Promise<boolean> {
  const payload = await requestJson<AuthSessionResponse>(API_ROUTES.authLogin, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ password }),
  });

  return payload.authenticated;
}

export async function logout(): Promise<boolean> {
  const payload = await requestJson<AuthSessionResponse>(API_ROUTES.authLogout, {
    method: "POST",
    credentials: "same-origin",
  });

  return payload.authenticated;
}

export function isAuthenticationError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 401;
  }

  return (
    (error instanceof UploadBatchError || error instanceof DeleteBatchError) &&
    isAuthenticationError(error.cause)
  );
}
