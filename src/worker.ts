import { ACCEPTED_IMAGE_TYPES, selectChunkedUploadPartSize } from "./uploadLimits";

const IMAGE_PREFIX = "images/";
const MULTIPART_UPLOAD_PREFIX = "multipart-uploads/";
const MAX_LOGIN_BODY_BYTES = 2048;
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const MIN_UPLOAD_PASSWORD_LENGTH = 12;
const MIN_AUTH_SECRET_LENGTH = 32;
const MAX_DELETE_BODY_BYTES = 1024 * 1024;
const MAX_DELETE_IMAGE_IDS = 5000;
const R2_DELETE_BATCH_SIZE = 1000;
const SESSION_COOKIE = "neuro_gallery_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PUBLIC_IMAGE_BASE_URL = "https://images.evilneur.org/";
const ALLOWED_TYPES = new Set<string>(ACCEPTED_IMAGE_TYPES);
const ILLEGAL_FILENAME_CHARACTERS = /[\x00-\x1f\x7f<>:"/\\|?*]+/g;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const EXTENSIONS_BY_TYPE = new Map([
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

interface Env {
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  AUTH_SECRET?: string;
  UPLOAD_PASSWORD?: string;
}

interface ImageRecord {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  contentType: string;
  url: string;
}

type JsonValue = Record<string, unknown> | unknown[];
type LoginPayload = {
  password?: unknown;
};
type MultipartStartPayload = {
  contentType?: unknown;
  name?: unknown;
  size?: unknown;
};
type MultipartCompletePayload = {
  parts?: unknown;
  uploadId?: unknown;
};
type DeleteImagesPayload = {
  ids?: unknown;
};
type MultipartUploadState = {
  contentType: string;
  id: string;
  key: string;
  name: string;
  partSize: number;
  size: number;
  uploadedAt: string;
  uploadId: string;
};
type R2ListWithMetadataOptions = R2ListOptions & {
  include?: ("customMetadata" | "httpMetadata")[];
};
type UploadFile = File & {
  arrayBuffer(): Promise<ArrayBuffer>;
  name: string;
  size: number;
  type: string;
  stream(): ReadableStream;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: preflightHeaders(request) });
    }

    try {
      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        return handleSession(request, env);
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        if (!isTrustedOrigin(request)) {
          return forbiddenOrigin();
        }

        return handleLogin(request, env);
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        if (!isTrustedOrigin(request)) {
          return forbiddenOrigin();
        }

        return handleLogout(request);
      }

      if (url.pathname === "/api/uploads/multipart" && request.method === "POST") {
        const guard = await mutationGuard(request, env);

        if (guard) {
          return guard;
        }

        return handleMultipartStart(request, env);
      }

      const multipartRoute = parseMultipartRoute(url.pathname);

      if (multipartRoute) {
        const guard = await mutationGuard(request, env);

        if (guard) {
          return guard;
        }

        if (multipartRoute.action === "part" && request.method === "PUT") {
          return handleMultipartPart(request, env, multipartRoute.id, multipartRoute.partNumber);
        }

        if (multipartRoute.action === "complete" && request.method === "POST") {
          return handleMultipartComplete(request, env, multipartRoute.id);
        }

        if (multipartRoute.action === "upload" && request.method === "DELETE") {
          return handleMultipartAbort(request, env, multipartRoute.id);
        }
      }

      if (url.pathname === "/random" || url.pathname === "/api/random") {
        return handleRandom(request, env);
      }

      if (url.pathname === "/api/images") {
        if (request.method === "GET") {
          return handleList(env);
        }

        if (request.method === "POST") {
          const guard = await mutationGuard(request, env);

          if (guard) {
            return guard;
          }

          return handleUpload(request, env);
        }

        if (request.method === "DELETE") {
          const guard = await mutationGuard(request, env);

          if (guard) {
            return guard;
          }

          return handleBulkDelete(request, env);
        }
      }

      if (url.pathname.startsWith("/api/images/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/images/".length));

        if (request.method === "GET" || request.method === "HEAD") {
          return handleImage(id, env, request.method === "HEAD");
        }

        if (request.method === "DELETE") {
          const guard = await mutationGuard(request, env);

          if (guard) {
            return guard;
          }

          return handleDelete(id, env);
        }
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof UploadHttpError) {
        return json({ error: error.message }, error.status);
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      return json({ error: message }, 500);
    }
  },
};

async function handleSession(request: Request, env: Env): Promise<Response> {
  return json({ authenticated: await isAuthenticated(request, env) });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!isAuthConfigured(env)) {
    return json({ error: "Upload authentication is not configured." }, 500);
  }

  const loginKey = loginAttemptKey(request);

  if (isLoginThrottled(loginKey)) {
    return json({ error: "Too many login attempts. Try again later." }, 429);
  }

  if (requestBodyTooLarge(request, MAX_LOGIN_BODY_BYTES)) {
    return json({ error: "Login request is too large." }, 413);
  }

  const payload = (await request.json().catch(() => ({}))) as LoginPayload;

  if (typeof payload.password !== "string" || !constantTimeEqual(payload.password, env.UPLOAD_PASSWORD || "")) {
    recordFailedLogin(loginKey);
    return json({ error: "Invalid upload password." }, 401);
  }

  clearLoginAttempts(loginKey);
  const token = await createSessionToken(env);

  return json(
    { authenticated: true },
    200,
    {
      "set-cookie": serializeSessionCookie(token, request, SESSION_TTL_SECONDS),
    },
  );
}

function handleLogout(request: Request): Response {
  return json(
    { authenticated: false },
    200,
    {
      "set-cookie": serializeSessionCookie("", request, 0),
    },
  );
}

async function handleList(env: Env): Promise<Response> {
  const images = await listImages(env);
  return json({ images, count: images.length });
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const values = [...form.getAll("images"), ...form.getAll("image")] as unknown[];
  const files = values.filter(isUploadFile);

  if (files.length === 0) {
    return json({ error: "Upload at least one image file." }, 400);
  }

  const uploaded: ImageRecord[] = [];

  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = detectImageContentType(bytes);
    const cleanName = sanitizeUploadedFileName(file.name, contentType || file.type);

    if (!contentType || !ALLOWED_TYPES.has(contentType)) {
      return json({ error: `${cleanName} is not a supported image type.` }, 415);
    }

    const id = createImageId(cleanName, contentType);
    const key = toStorageKey(id);
    const uploadedAt = new Date().toISOString();

    await env.IMAGES.put(key, bytes, {
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        name: cleanName,
        uploadedAt,
      },
    });

    uploaded.push({
      id,
      name: cleanName,
      size: file.size,
      uploadedAt,
      contentType,
      url: toPublicImageUrl(id),
    });
  }

  return json({ uploaded, count: uploaded.length }, 201);
}

async function handleMultipartStart(request: Request, env: Env): Promise<Response> {
  const payload = (await request.json().catch(() => ({}))) as MultipartStartPayload;

  if (typeof payload.name !== "string" || !payload.name.trim()) {
    return json({ error: "Upload filename is required." }, 400);
  }

  if (typeof payload.contentType !== "string" || !ALLOWED_TYPES.has(payload.contentType)) {
    return json({ error: "Unsupported image type." }, 415);
  }

  if (typeof payload.size !== "number" || !Number.isFinite(payload.size) || payload.size <= 0) {
    return json({ error: "Upload size is invalid." }, 400);
  }

  const cleanName = sanitizeUploadedFileName(payload.name, payload.contentType);
  const id = createImageId(cleanName, payload.contentType);
  const key = toStorageKey(id);
  const uploadedAt = new Date().toISOString();
  const partSize = selectChunkedUploadPartSize(payload.size);
  const upload = await env.IMAGES.createMultipartUpload(key, {
    httpMetadata: {
      contentType: payload.contentType,
    },
    customMetadata: {
      name: cleanName,
      uploadedAt,
    },
  });
  const state: MultipartUploadState = {
    contentType: payload.contentType,
    id,
    key,
    name: cleanName,
    partSize,
    size: payload.size,
    uploadedAt,
    uploadId: upload.uploadId,
  };

  try {
    await env.IMAGES.put(toMultipartStateKey(id), JSON.stringify(state), {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }

  return json({
    id,
    uploadId: upload.uploadId,
    partSize,
    name: cleanName,
    size: payload.size,
    uploadedAt,
    contentType: payload.contentType,
    url: toPublicImageUrl(id),
  });
}

async function handleMultipartPart(request: Request, env: Env, id: string, partNumber: number): Promise<Response> {
  if (!isValidImageId(id)) {
    return json({ error: "Invalid upload id." }, 400);
  }

  if (!Number.isInteger(partNumber) || partNumber < 1) {
    return json({ error: "Invalid upload part number." }, 400);
  }

  const uploadId = new URL(request.url).searchParams.get("uploadId");
  const state = await getMultipartState(env, id);

  if (!state) {
    return json({ error: "Multipart upload was not found." }, 404);
  }

  if (!uploadId || uploadId !== state.uploadId) {
    return json({ error: "Multipart upload id is invalid." }, 400);
  }

  if (!request.body) {
    return json({ error: "Upload part is empty." }, 400);
  }

  const upload = env.IMAGES.resumeMultipartUpload(state.key, state.uploadId);
  const part =
    partNumber === 1
      ? await uploadFirstMultipartPart(request, env, upload, state, partNumber)
      : await upload.uploadPart(partNumber, request.body);

  return json({ part });
}

async function uploadFirstMultipartPart(
  request: Request,
  env: Env,
  upload: R2MultipartUpload,
  state: MultipartUploadState,
  partNumber: number,
): Promise<R2UploadedPart> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const contentType = detectImageContentType(bytes);

  if (!contentType || !ALLOWED_TYPES.has(contentType)) {
    await upload.abort().catch(() => undefined);
    await removeMultipartState(env, state);
    throw new UploadHttpError(`${state.name} is not a supported image type.`, 415);
  }

  if (contentType !== state.contentType) {
    await upload.abort().catch(() => undefined);
    await removeMultipartState(env, state);
    throw new UploadHttpError(`${state.name} does not match its detected image type.`, 415);
  }

  return upload.uploadPart(partNumber, bytes);
}

async function handleMultipartComplete(request: Request, env: Env, id: string): Promise<Response> {
  if (!isValidImageId(id)) {
    return json({ error: "Invalid upload id." }, 400);
  }

  const payload = (await request.json().catch(() => ({}))) as MultipartCompletePayload;
  const state = await getMultipartState(env, id);

  if (!state) {
    return json({ error: "Multipart upload was not found." }, 404);
  }

  if (payload.uploadId !== state.uploadId) {
    return json({ error: "Multipart upload id is invalid." }, 400);
  }

  const parts = parseUploadedParts(payload.parts);

  if (!parts.length || !partsMatchUpload(parts, state)) {
    return json({ error: "Upload has no completed parts." }, 400);
  }

  const object = await env.IMAGES.resumeMultipartUpload(state.key, state.uploadId).complete(parts);

  await env.IMAGES.delete(toMultipartStateKey(id));

  return json({
    image: {
      id: state.id,
      name: state.name,
      size: object.size || state.size,
      uploadedAt: state.uploadedAt,
      contentType: state.contentType,
      url: toPublicImageUrl(state.id),
    },
  });
}

async function handleMultipartAbort(request: Request, env: Env, id: string): Promise<Response> {
  if (!isValidImageId(id)) {
    return json({ error: "Invalid upload id." }, 400);
  }

  const uploadId = new URL(request.url).searchParams.get("uploadId");
  const state = await getMultipartState(env, id);

  if (!state) {
    return json({ ok: true });
  }

  if (uploadId && uploadId !== state.uploadId) {
    return json({ error: "Multipart upload id is invalid." }, 400);
  }

  await env.IMAGES.resumeMultipartUpload(state.key, state.uploadId).abort().catch(() => undefined);
  await env.IMAGES.delete(toMultipartStateKey(id));

  return json({ ok: true });
}

async function removeMultipartState(env: Env, state: MultipartUploadState): Promise<void> {
  await env.IMAGES.delete(toMultipartStateKey(state.id));
}

async function handleImage(id: string, env: Env, headOnly = false): Promise<Response> {
  const key = toStorageKey(id);

  if (!isValidImageId(id)) {
    return json({ error: "Invalid image id." }, 400);
  }

  const object = await env.IMAGES.get(key);

  if (!object) {
    return json({ error: "Image not found." }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("x-content-type-options", "nosniff");

  return new Response(headOnly ? null : object.body, { headers });
}

async function handleDelete(id: string, env: Env): Promise<Response> {
  if (!isValidImageId(id)) {
    return json({ error: "Invalid image id." }, 400);
  }

  await env.IMAGES.delete(toStorageKey(id));
  return json({ ok: true });
}

async function handleBulkDelete(request: Request, env: Env): Promise<Response> {
  if (requestBodyTooLarge(request, MAX_DELETE_BODY_BYTES)) {
    return json({ error: "Delete request is too large." }, 413);
  }

  const payload = (await request.json().catch(() => null)) as DeleteImagesPayload | null;
  const parsed = parseDeleteImageIds(payload);

  if ("error" in parsed) {
    return json({ error: parsed.error }, 400);
  }

  await deleteImageIds(parsed.ids, env);
  return json({ ok: true, deleted: parsed.ids, count: parsed.ids.length });
}

async function deleteImageIds(ids: string[], env: Env): Promise<void> {
  const keyBatches: string[][] = [];

  for (let index = 0; index < ids.length; index += R2_DELETE_BATCH_SIZE) {
    keyBatches.push(ids.slice(index, index + R2_DELETE_BATCH_SIZE).map((id) => toStorageKey(id)));
  }

  await Promise.all(keyBatches.map((keys) => env.IMAGES.delete(keys)));
}

function parseDeleteImageIds(payload: DeleteImagesPayload | null): { ids: string[] } | { error: string } {
  if (!payload || !Array.isArray(payload.ids)) {
    return { error: "Provide image ids to delete." };
  }

  if (payload.ids.length > MAX_DELETE_IMAGE_IDS) {
    return { error: `Delete at most ${MAX_DELETE_IMAGE_IDS} images at a time.` };
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (const id of payload.ids) {
    if (typeof id !== "string" || !isValidImageId(id)) {
      return { error: "Delete request contains an invalid image id." };
    }

    if (!seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }

  if (ids.length === 0) {
    return { error: "Select at least one image to delete." };
  }

  return { ids };
}

async function handleRandom(request: Request, env: Env): Promise<Response> {
  const images = await listImages(env);

  if (images.length === 0) {
    return json({ error: "No uploaded images are available yet." }, 404);
  }

  const image = images[Math.floor(Math.random() * images.length)];
  const url = new URL(request.url);

  if (url.searchParams.get("format") === "json") {
    return json({ image });
  }

  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location: new URL(image.url, request.url).toString(),
    },
  });
}

async function listImages(env: Env): Promise<ImageRecord[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;

  do {
    const listOptions: R2ListWithMetadataOptions = {
      prefix: IMAGE_PREFIX,
      cursor,
      limit: 1000,
      include: ["httpMetadata", "customMetadata"],
    };
    const result = await env.IMAGES.list(listOptions);

    objects.push(...result.objects);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return objects
    .map((object) => toImageRecord(object))
    .sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
}

function toImageRecord(object: R2Object): ImageRecord {
  const id = object.key.slice(IMAGE_PREFIX.length);
  const metadata = object.customMetadata ?? {};

  return {
    id,
    name: metadata.name || readableNameFromId(id),
    size: object.size,
    uploadedAt: metadata.uploadedAt || object.uploaded.toISOString(),
    contentType: object.httpMetadata?.contentType || "image/*",
    url: toPublicImageUrl(id),
  };
}

function toPublicImageUrl(id: string): string {
  return new URL(`${IMAGE_PREFIX}${encodeURIComponent(id)}`, PUBLIC_IMAGE_BASE_URL).toString();
}

function createImageId(fileName: string, contentType: string): string {
  const extension = extensionFromContentType(contentType);
  const random = crypto.randomUUID().slice(0, 8);
  const stem = sanitizeIdStem(fileName.replace(/\.[^.]+$/, ""));

  return `${Date.now()}-${random}-${stem}${extension}`;
}

function extensionFromContentType(contentType: string): string {
  return EXTENSIONS_BY_TYPE.get(contentType) || ".img";
}

function sanitizeUploadedFileName(fileName: string, contentType: string): string {
  const extension = extensionFromContentType(contentType);
  const stem = fileName.replace(/\.[^.]+$/, "");
  const cleanStem = removeIllegalFilenameCharacters(stem).replace(/\s+/g, " ").trim().slice(0, 96) || "upload";

  return `${cleanStem}${extension}`;
}

function removeIllegalFilenameCharacters(value: string): string {
  return value.replace(ILLEGAL_FILENAME_CHARACTERS, "").replace(/\.+$/g, "");
}

function sanitizeIdStem(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "upload"
  );
}

function readableNameFromId(id: string): string {
  return id
    .replace(/^\d+-[a-f0-9-]+-/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/-/g, " ");
}

function toStorageKey(id: string): string {
  return `${IMAGE_PREFIX}${id}`;
}

function toMultipartStateKey(id: string): string {
  return `${MULTIPART_UPLOAD_PREFIX}${id}.json`;
}

function isValidImageId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/.test(id);
}

function isUploadFile(value: unknown): value is UploadFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "size" in value &&
    "type" in value &&
    "arrayBuffer" in value &&
    "stream" in value &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.type === "string" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.stream === "function" &&
    value.size > 0
  );
}

function authRequired(): Response {
  return json({ error: "Sign in before changing images." }, 401);
}

async function mutationGuard(request: Request, env: Env): Promise<Response | null> {
  if (!isTrustedOrigin(request)) {
    return forbiddenOrigin();
  }

  if (!(await isAuthenticated(request, env))) {
    return authRequired();
  }

  return null;
}

function forbiddenOrigin(): Response {
  return json({ error: "Cross-origin mutation requests are not allowed." }, 403);
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!isAuthConfigured(env)) {
    return false;
  }

  const token = getCookie(request.headers.get("cookie") || "", SESSION_COOKIE);
  return token ? verifySessionToken(token, env) : false;
}

function isAuthConfigured(env: Env): boolean {
  return Boolean(
    env.AUTH_SECRET &&
      env.AUTH_SECRET.length >= MIN_AUTH_SECRET_LENGTH &&
      env.UPLOAD_PASSWORD &&
      env.UPLOAD_PASSWORD.length >= MIN_UPLOAD_PASSWORD_LENGTH,
  );
}

async function createSessionToken(env: Env): Promise<string> {
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: "uploader",
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
  );
  const signature = await sign(payload, env.AUTH_SECRET || "");

  return `${payload}.${signature}`;
}

async function verifySessionToken(token: string, env: Env): Promise<boolean> {
  const parts = token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const [payload, signature] = parts;

  if (!payload || !signature) {
    return false;
  }

  const expectedSignature = await sign(payload, env.AUTH_SECRET || "");

  if (!constantTimeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const session = JSON.parse(base64UrlDecode(payload)) as { exp?: unknown; sub?: unknown };
    return session.sub === "uploader" && typeof session.exp === "number" && session.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));

  return base64UrlEncode(signature);
}

function serializeSessionCookie(value: string, request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";

  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function getCookie(cookieHeader: string, name: string): string | null {
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  const prefix = `${name}=`;
  const cookie = cookies.find((part) => part.startsWith(prefix));

  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
}

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }

  return diff === 0;
}

function loginAttemptKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
}

function isLoginThrottled(key: string): boolean {
  const attempt = loginAttempts.get(key);
  const now = Date.now();

  if (!attempt) {
    return false;
  }

  if (attempt.resetAt <= now) {
    loginAttempts.delete(key);
    return false;
  }

  return attempt.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(key: string): void {
  const now = Date.now();
  const attempt = loginAttempts.get(key);

  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(key, {
      count: 1,
      resetAt: now + LOGIN_ATTEMPT_WINDOW_MS,
    });
    return;
  }

  attempt.count += 1;
}

function clearLoginAttempts(key: string): void {
  loginAttempts.delete(key);
}

async function getMultipartState(env: Env, id: string): Promise<MultipartUploadState | null> {
  const object = await env.IMAGES.get(toMultipartStateKey(id));

  if (!object) {
    return null;
  }

  try {
    return (await object.json()) as MultipartUploadState;
  } catch {
    return null;
  }
}

function parseUploadedParts(value: unknown): R2UploadedPart[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((part) => {
      if (
        typeof part !== "object" ||
        part === null ||
        !("partNumber" in part) ||
        !("etag" in part) ||
        typeof part.partNumber !== "number" ||
        !Number.isInteger(part.partNumber) ||
        part.partNumber < 1 ||
        typeof part.etag !== "string" ||
        !part.etag
      ) {
        return null;
      }

      return {
        partNumber: part.partNumber,
        etag: part.etag,
      };
    })
    .filter((part): part is R2UploadedPart => Boolean(part))
    .sort((a, b) => a.partNumber - b.partNumber);
}

function partsMatchUpload(parts: R2UploadedPart[], state: MultipartUploadState): boolean {
  const expectedPartCount = Math.ceil(state.size / state.partSize);

  return parts.length === expectedPartCount && parts.every((part, index) => part.partNumber === index + 1);
}

function parseMultipartRoute(pathname: string):
  | { action: "complete"; id: string }
  | { action: "part"; id: string; partNumber: number }
  | { action: "upload"; id: string }
  | null {
  const uploadMatch = pathname.match(/^\/api\/uploads\/multipart\/([^/]+)$/);

  if (uploadMatch?.[1]) {
    return { action: "upload", id: decodeURIComponent(uploadMatch[1]) };
  }

  const partMatch = pathname.match(/^\/api\/uploads\/multipart\/([^/]+)\/parts\/(\d+)$/);

  if (partMatch?.[1] && partMatch[2]) {
    return {
      action: "part",
      id: decodeURIComponent(partMatch[1]),
      partNumber: Number.parseInt(partMatch[2], 10),
    };
  }

  const completeMatch = pathname.match(/^\/api\/uploads\/multipart\/([^/]+)\/complete$/);

  if (completeMatch?.[1]) {
    return { action: "complete", id: decodeURIComponent(completeMatch[1]) };
  }

  return null;
}

function requestBodyTooLarge(request: Request, maxBytes: number): boolean {
  const contentLength = request.headers.get("content-length");

  if (!contentLength) {
    return false;
  }

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed > maxBytes;
}

function isTrustedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (!origin) {
    return true;
  }

  return origin === new URL(request.url).origin;
}

function detectImageContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return "image/gif";
  }

  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }

  if (ascii(bytes, 4, 4) === "ftyp" && ascii(bytes, 8, 24).includes("avif")) {
    return "image/avif";
  }

  return null;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function json(data: JsonValue, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}

class UploadHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function preflightHeaders(request: Request): Record<string, string> {
  if (!isTrustedOrigin(request)) {
    return {};
  }

  const origin = request.headers.get("origin") || new URL(request.url).origin;

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
