import { DEFAULT_CHUNKED_UPLOAD_PART_BYTES } from "../uploadLimits";
import type {
  AuthSessionResponse,
  GalleryImage,
  ImagesResponse,
  MultipartUploadCompleteResponse,
  MultipartUploadPartResponse,
  MultipartUploadStartResponse,
  RandomResponse,
  UploadResponse,
} from "./types";

export interface UploadProgress {
  fileIndex: number;
  fileCount: number;
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text().catch(() => "");
  const payload = parseJson(text);

  if (!response.ok) {
    throw new Error(errorMessage(response, payload, text));
  }

  return payload as T;
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

export async function fetchImages(): Promise<GalleryImage[]> {
  const payload = await requestJson<ImagesResponse>("/api/images");
  return payload.images;
}

export async function uploadImages(files: File[], onProgress?: (progress: UploadProgress) => void): Promise<GalleryImage[]> {
  const uploaded: GalleryImage[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const progressBase = {
      fileIndex: index,
      fileCount: files.length,
      fileName: file.name,
      totalBytes: file.size,
    };

    if (file.size > DEFAULT_CHUNKED_UPLOAD_PART_BYTES) {
      uploaded.push(await uploadLargeImage(file, (uploadedBytes) => onProgress?.({ ...progressBase, uploadedBytes })));
      continue;
    }

    const image = await uploadSingleImage(file);
    uploaded.push(image);
    onProgress?.({ ...progressBase, uploadedBytes: file.size });
  }

  return uploaded;
}

async function uploadSingleImage(file: File): Promise<GalleryImage> {
  const body = new FormData();

  body.append("images", file);

  const payload = await requestJson<UploadResponse>("/api/images", {
    method: "POST",
    body,
    credentials: "same-origin",
  });

  const image = payload.uploaded[0];

  if (!image) {
    throw new Error("Upload completed without an image record.");
  }

  return image;
}

async function uploadLargeImage(file: File, onProgress?: (uploadedBytes: number) => void): Promise<GalleryImage> {
  let upload: MultipartUploadStartResponse | null = null;

  try {
    upload = await requestJson<MultipartUploadStartResponse>("/api/uploads/multipart", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type,
      }),
    });

    const parts: MultipartUploadPartResponse["part"][] = [];
    const totalParts = Math.ceil(file.size / upload.partSize);

    for (let index = 0; index < totalParts; index += 1) {
      const partNumber = index + 1;
      const start = index * upload.partSize;
      const end = Math.min(start + upload.partSize, file.size);
      const chunk = file.slice(start, end);
      const part = await uploadMultipartPart(upload, partNumber, chunk);

      parts.push(part);
      onProgress?.(end);
    }

    const completed = await requestJson<MultipartUploadCompleteResponse>(
      `/api/uploads/multipart/${encodeURIComponent(upload.id)}/complete`,
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

async function uploadMultipartPart(upload: MultipartUploadStartResponse, partNumber: number, chunk: Blob): Promise<MultipartUploadPartResponse["part"]> {
  const payload = await requestJson<MultipartUploadPartResponse>(
    `/api/uploads/multipart/${encodeURIComponent(upload.id)}/parts/${partNumber}?uploadId=${encodeURIComponent(upload.uploadId)}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: chunk,
    },
  );

  return payload.part;
}

async function abortMultipartUpload(upload: MultipartUploadStartResponse): Promise<void> {
  await requestJson<{ ok: boolean }>(
    `/api/uploads/multipart/${encodeURIComponent(upload.id)}?uploadId=${encodeURIComponent(upload.uploadId)}`,
    {
      method: "DELETE",
      credentials: "same-origin",
    },
  );
}

export async function fetchRandomImage(): Promise<GalleryImage> {
  const payload = await requestJson<RandomResponse>("/api/random?format=json");
  return payload.image;
}

export async function deleteImage(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/images/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
}

export async function fetchAuthSession(): Promise<boolean> {
  const payload = await requestJson<AuthSessionResponse>("/api/auth/session", {
    credentials: "same-origin",
  });
  return payload.authenticated;
}

export async function login(password: string): Promise<boolean> {
  const payload = await requestJson<AuthSessionResponse>("/api/auth/login", {
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
  const payload = await requestJson<AuthSessionResponse>("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });

  return payload.authenticated;
}
