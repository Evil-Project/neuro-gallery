import type { AuthSessionResponse, GalleryImage, ImagesResponse, RandomResponse, UploadResponse } from "./types";
import { MAX_UPLOAD_FILES, MAX_UPLOAD_SIZE_LABEL, MAX_UPLOAD_TOTAL_SIZE_LABEL } from "../uploadLimits";

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
    return `Request is too large. Upload at most ${MAX_UPLOAD_FILES} images, ${MAX_UPLOAD_SIZE_LABEL} each and ${MAX_UPLOAD_TOTAL_SIZE_LABEL} total.`;
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

export async function uploadImages(files: File[]): Promise<GalleryImage[]> {
  const body = new FormData();

  files.forEach((file) => body.append("images", file));

  const payload = await requestJson<UploadResponse>("/api/images", {
    method: "POST",
    body,
    credentials: "same-origin",
  });

  return payload.uploaded;
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
