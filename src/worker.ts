const IMAGE_PREFIX = "images/";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SESSION_COOKIE = "neuro_gallery_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const ALLOWED_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
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
  name: string;
  size: number;
  type: string;
  stream(): ReadableStream;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        return handleSession(request, env);
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        return handleLogin(request, env);
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
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

  const payload = (await request.json().catch(() => ({}))) as LoginPayload;

  if (typeof payload.password !== "string" || !constantTimeEqual(payload.password, env.UPLOAD_PASSWORD || "")) {
    return json({ error: "Invalid upload password." }, 401);
  }

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
    if (!ALLOWED_TYPES.has(file.type)) {
      return json({ error: `${file.name} is not a supported image type.` }, 415);
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ error: `${file.name} is larger than 10 MB.` }, 413);
    }

    const id = createImageId(file);
    const key = toStorageKey(id);
    const uploadedAt = new Date().toISOString();

    await env.IMAGES.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type,
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
      contentType: file.type,
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
  headers.set("access-control-allow-origin", "*");

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

  return Response.redirect(new URL(image.url, request.url).toString(), 302);
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

function createImageId(file: UploadFile): string {
  const extension = extensionFromFile(file);
  const random = crypto.randomUUID().slice(0, 8);
  const stem = sanitizeName(file.name.replace(/\.[^.]+$/, ""));

  return `${Date.now()}-${random}-${stem}${extension}`;
}

function extensionFromFile(file: UploadFile): string {
  const fromName = file.name.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();

  if (fromName) {
    return fromName;
  }

  const fromType = file.type.split("/")[1];
  return fromType ? `.${fromType.replace("svg+xml", "svg")}` : ".img";
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
    "stream" in value &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.type === "string" &&
    typeof value.stream === "function" &&
    value.size > 0
  );
}

function authRequired(): Response {
  return json({ error: "Sign in before changing images." }, 401);
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!isAuthConfigured(env)) {
    return false;
  }

  const token = getCookie(request.headers.get("cookie") || "", SESSION_COOKIE);
  return token ? verifySessionToken(token, env) : false;
}

function isAuthConfigured(env: Env): boolean {
  return Boolean(env.AUTH_SECRET && env.UPLOAD_PASSWORD);
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
  const [payload, signature] = token.split(".");

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

  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
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

function json(data: JsonValue, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
