const IMAGE_PREFIX = "images/";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_FILES = 8;
const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES * MAX_UPLOAD_FILES;
const MAX_LOGIN_BODY_BYTES = 2048;
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const MIN_UPLOAD_PASSWORD_LENGTH = 12;
const MIN_AUTH_SECRET_LENGTH = 32;
const SESSION_COOKIE = "neuro_gallery_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const ALLOWED_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
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

      if (url.pathname === "/random" || url.pathname === "/api/random") {
        return handleRandom(request, env);
      }

      if (url.pathname === "/api/images") {
        if (request.method === "GET") {
          return handleList(env);
        }

        if (request.method === "POST") {
          if (!isTrustedOrigin(request)) {
            return forbiddenOrigin();
          }

          if (!(await isAuthenticated(request, env))) {
            return authRequired();
          }

          return handleUpload(request, env);
        }
      }

      if (url.pathname.startsWith("/api/images/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/images/".length));

        if (request.method === "GET" || request.method === "HEAD") {
          return handleImage(id, env, request.method === "HEAD");
        }

        if (request.method === "DELETE") {
          if (!isTrustedOrigin(request)) {
            return forbiddenOrigin();
          }

          if (!(await isAuthenticated(request, env))) {
            return authRequired();
          }

          return handleDelete(id, env);
        }
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
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
  if (requestBodyTooLarge(request, MAX_UPLOAD_BODY_BYTES)) {
    return json({ error: "Upload request is too large." }, 413);
  }

  const form = await request.formData();
  const values = [...form.getAll("images"), ...form.getAll("image")] as unknown[];
  const files = values.filter(isUploadFile);

  if (files.length === 0) {
    return json({ error: "Upload at least one image file." }, 400);
  }

  if (files.length > MAX_UPLOAD_FILES) {
    return json({ error: `Upload at most ${MAX_UPLOAD_FILES} images at once.` }, 413);
  }

  const totalUploadBytes = files.reduce((total, file) => total + file.size, 0);

  if (totalUploadBytes > MAX_UPLOAD_BODY_BYTES) {
    return json({ error: "Combined upload size is too large." }, 413);
  }

  const uploaded: ImageRecord[] = [];

  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ error: `${file.name} is larger than 10 MB.` }, 413);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = detectImageContentType(bytes);

    if (!contentType || !ALLOWED_TYPES.has(contentType)) {
      return json({ error: `${file.name} is not a supported image type.` }, 415);
    }

    const id = createImageId(file, contentType);
    const key = toStorageKey(id);
    const uploadedAt = new Date().toISOString();

    await env.IMAGES.put(key, bytes, {
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        name: file.name,
        uploadedAt,
      },
    });

    uploaded.push({
      id,
      name: file.name,
      size: file.size,
      uploadedAt,
      contentType,
      url: `/api/images/${encodeURIComponent(id)}`,
    });
  }

  return json({ uploaded, count: uploaded.length }, 201);
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
    url: `/api/images/${encodeURIComponent(id)}`,
  };
}

function createImageId(file: UploadFile, contentType: string): string {
  const extension = extensionFromContentType(contentType);
  const random = crypto.randomUUID().slice(0, 8);
  const stem = sanitizeName(file.name.replace(/\.[^.]+$/, ""));

  return `${Date.now()}-${random}-${stem}${extension}`;
}

function extensionFromContentType(contentType: string): string {
  return EXTENSIONS_BY_TYPE.get(contentType) || ".img";
}

function sanitizeName(name: string): string {
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

function preflightHeaders(request: Request): Record<string, string> {
  if (!isTrustedOrigin(request)) {
    return {};
  }

  const origin = request.headers.get("origin") || new URL(request.url).origin;

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
