import type { AuthSessionResponse, GalleryImage, ImagesResponse, RandomResponse, UploadResponse } from "./types";

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }

  return payload as T;
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
