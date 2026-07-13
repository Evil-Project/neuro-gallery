import {
  API_BASE_PATH,
  API_HEADERS,
  API_ROUTES,
  LEGACY_API_BASE_PATH,
  PUBLIC_RANDOM_PATH,
  type GalleryImage,
  type MultipartUploadStartResponse,
} from "./apiContract";
import {
  ACCEPTED_IMAGE_TYPES,
  DEFAULT_CHUNKED_UPLOAD_PART_BYTES,
  MAX_DELETE_IMAGE_IDS_PER_REQUEST,
  MAX_DIRECT_UPLOAD_BODY_BYTES,
  MAX_DIRECT_UPLOAD_FILES,
  MAX_DIRECT_UPLOAD_TOTAL_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  selectChunkedUploadPartSize,
} from "./uploadLimits";

const IMAGE_PREFIX = "images/";
const MULTIPART_UPLOAD_PREFIX = "multipart-uploads/";
const IMAGE_CATALOG_KEY = "catalog/images-v1.json";
const IMAGE_RESERVATIONS_KEY = "catalog/image-reservations-v1.json";
const LEGACY_RETIRED_IMAGES_KEY_PREFIX = "catalog/retired-images-v1/";
const RETIRED_IMAGE_MARKER_PREFIX = "catalog/retired-images-v2/";
const IMAGE_CATALOG_VERSION = 1;
const IMAGE_RESERVATIONS_VERSION = 1;
const LEGACY_RETIRED_IMAGES_VERSION = 1;
const IMAGE_CATALOG_CACHE_MS = 2_000;
const MAX_CATALOG_IMAGES = 2_000;
const MAX_READABLE_CATALOG_IMAGES = 50_000;
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_GALLERY_BYTES = 9_000_000_000;
const MAX_PENDING_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_STORED_IMAGE_BYTES = 5 * 1024 * 1024 * 1024 * 1024;
const CATALOG_MUTATION_ATTEMPTS = 6;
const MAX_LOGIN_BODY_BYTES = 2_048;
const MAX_MULTIPART_START_BODY_BYTES = 4_096;
const MAX_MULTIPART_COMPLETE_BODY_BYTES = 64 * 1024;
const MAX_DELETE_BODY_BYTES = 1024 * 1024;
const R2_DELETE_BATCH_SIZE = 1_000;
const MULTIPART_CLEANUP_PAGE_SIZE = 8;
const MAX_ACTIVE_MULTIPART_UPLOADS = 50;
const MAX_PENDING_IMAGE_RESERVATIONS = 128;
const MULTIPART_RESERVATION_LEASE_MS = 60 * 1000;
const MAX_IMAGE_RESERVATIONS_BYTES = 256 * 1024;
const LEGACY_RETIRED_IMAGE_SHARD_COUNT = 16;
const MAX_LEGACY_RETIRED_IMAGE_SHARD_BYTES = 1024 * 1024;
const MAX_LEGACY_RETIRED_IMAGES_PER_SHARD = 4_096;
const MAX_RETIRED_MARKERS_FOR_CATALOG_REBUILD = 100_000;
const MAX_SCANNED_IMAGE_OBJECTS = MAX_READABLE_CATALOG_IMAGES + MAX_PENDING_IMAGE_RESERVATIONS;
const STALE_MULTIPART_UPLOAD_MS = 12 * 60 * 60 * 1000;
const RETIRED_IMAGE_TTL_MS = 370 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "neuro_gallery_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const MIN_UPLOAD_PASSWORD_LENGTH = 12;
const MIN_AUTH_SECRET_LENGTH = 32;
const MAX_SESSION_TOKEN_LENGTH = 2_048;
const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const LEGACY_CLEANUP_COMPLETE_KEY = "maintenance/legacy-multipart-cleanup-complete";
const STATE_CLEANUP_CURSOR_KEY = "maintenance/state-multipart-cleanup-cursor";
const LEGACY_CLEANUP_CURSOR_KEY = "maintenance/legacy-multipart-cleanup-cursor";
const STORED_IMAGE_RECONCILIATION_CURSOR_KEY = "maintenance/stored-image-reconciliation-cursor";
const CATALOG_RECONCILIATION_OFFSET_KEY = "maintenance/catalog-reconciliation-offset";
const IMAGE_RECONCILIATION_PAGE_SIZE = 8;
const STALE_DIRECT_UPLOAD_MS = 5 * 60 * 1000;
const ALLOWED_TYPES = new Set<string>(ACCEPTED_IMAGE_TYPES);
const ILLEGAL_FILENAME_CHARACTERS = /[\x00-\x1f\x7f<>:"/\\|?*]+/g;
const CLIENT_UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_SIGNATURE_BYTES = 32;
const EXTENSIONS_BY_TYPE = new Map([
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

interface Env {
  IMAGES: R2Bucket;
  STATE: R2Bucket;
  ASSETS: Fetcher;
  LOGIN_RATE_LIMITER: RateLimit;
  MUTATION_RATE_LIMITER: RateLimit;
  PUBLIC_API_RATE_LIMITER: RateLimit;
  AUTH_SECRET?: string;
  PUBLIC_IMAGE_BASE_URL?: string;
  UPLOAD_PASSWORD?: string;
}

interface StoredImageRecord {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  contentType: string;
}

interface ImageCatalog {
  version: 1;
  updatedAt: string;
  images: StoredImageRecord[];
}

interface CatalogSnapshot {
  catalog: ImageCatalog;
  etag: string;
  httpEtag: string;
}

interface ImageUploadReservation {
  clientUploadId: string;
  contentType: string;
  digest?: string;
  id: string;
  mode: "direct" | "multipart";
  name: string;
  reservedAt: string;
  size: number;
}

interface ImageUploadReservations {
  version: 1;
  uploads: ImageUploadReservation[];
}

interface ImageReservationExpectation {
  clientUploadId?: string;
  id: string;
  mode: "direct" | "multipart";
  reservedAt: string;
}

interface RetiredImageRecord {
  id: string;
  retiredAt: string;
}

interface RetiredImages {
  version: 1;
  images: RetiredImageRecord[];
}

interface MultipartUploadState {
  clientUploadId?: string;
  contentType: string;
  id: string;
  key: string;
  name: string;
  orphaned?: boolean;
  partSize: number;
  size: number;
  uploadedAt: string;
  uploadId: string;
}

interface MultipartStateLocation {
  bucket: R2Bucket;
  etag: string;
  key: string;
  state: MultipartUploadState;
}

interface MultipartStateSnapshot {
  etag: string;
  state: MultipartUploadState;
}

interface MultipartCleanupResult {
  aborted: number;
  errors: number;
  inspected: number;
  pending: boolean;
  removed: number;
  skipped: number;
  staleAfterMs: number;
  staleBefore: string;
}

interface PreparedUpload {
  bytes: Uint8Array;
  contentType: string;
  digest: string;
  id: string;
  key: string;
  name: string;
  size: number;
  uploadedAt: string;
  uploadKey: string;
}

type LoginPayload = { password?: unknown };
type MultipartStartPayload = { contentType?: unknown; name?: unknown; size?: unknown };
type MultipartCompletePayload = { parts?: unknown; uploadId?: unknown };
type DeleteImagesPayload = { ids?: unknown };
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

let cachedCatalog: (CatalogSnapshot & { expiresAt: number }) | null = null;
let cachedAuthKey: { key: CryptoKey; secret: string } | null = null;

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const tasks = await Promise.allSettled([
      cleanupStaleMultipartUploads(env).then((result) => {
        if (result.errors > 0) {
          throw new Error(`Multipart cleanup could not abort ${result.errors} stale upload(s).`);
        }

        return result;
      }),
      cleanupStaleImageReservations(env),
      pruneLegacyRetiredImageShardPage(env),
      reconcileImageCatalogPage(env),
    ]);
    const failures: string[] = [];

    for (const task of tasks) {
      if (task.status === "rejected") {
        const failure = safeErrorMessage(task.reason);
        failures.push(failure);
        console.error("Scheduled maintenance failed", failure);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Scheduled maintenance failed: ${failures.join("; ")}`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const canonical = canonicalApiPath(url.pathname);
    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();

    let response: Response;

    try {
      response =
        request.method === "OPTIONS"
          ? new Response(null, { status: 204, headers: preflightHeaders(request) })
          : await dispatchRequest(request, env, canonical.pathname);
    } catch (error) {
      if (error instanceof HttpError) {
        response = json({ error: error.message }, error.status, error.headers);
      } else {
        console.error("Unhandled Worker request error", {
          error: safeErrorMessage(error),
          method: request.method,
          path: url.pathname,
          requestId,
        });

        response = json({ error: "The request could not be completed.", requestId }, 500, { "x-request-id": requestId });
      }
    }

    return canonical.legacy ? withLegacyApiHeaders(response, request, canonical.pathname) : response;
  },
} satisfies ExportedHandler<Env>;

async function dispatchRequest(request: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === API_ROUTES.authSession) {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }

    await requirePublicApiCapacity(request, env);
    return handleSession(request, env);
  }

  if (pathname === API_ROUTES.authLogin) {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    requireTrustedOrigin(request);
    return handleLogin(request, env);
  }

  if (pathname === API_ROUTES.authLogout) {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    requireTrustedOrigin(request);
    return handleLogout(request);
  }

  if (pathname === API_ROUTES.multipartCleanup) {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    await requireMutationAccess(request, env);
    return json(await cleanupStaleMultipartUploads(env));
  }

  if (pathname === API_ROUTES.multipartUploads) {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    await requireMutationAccess(request, env);
    return handleMultipartStart(request, env);
  }

  const multipartRoute = parseMultipartRoute(pathname);

  if (multipartRoute) {
    await requireMutationAccess(request, env);

    if (multipartRoute.action === "part") {
      return request.method === "PUT"
        ? handleMultipartPart(request, env, multipartRoute.id, multipartRoute.partNumber)
        : methodNotAllowed(["PUT"]);
    }

    if (multipartRoute.action === "complete") {
      return request.method === "POST"
        ? handleMultipartComplete(request, env, multipartRoute.id)
        : methodNotAllowed(["POST"]);
    }

    return request.method === "DELETE"
      ? handleMultipartAbort(request, env, multipartRoute.id)
      : methodNotAllowed(["DELETE"]);
  }

  if (pathname === PUBLIC_RANDOM_PATH || pathname === API_ROUTES.random) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }

    await requirePublicApiCapacity(request, env);
    return handleRandom(request, env);
  }

  if (pathname === API_ROUTES.images) {
    if (request.method === "GET") {
      await requirePublicApiCapacity(request, env);
      return handleList(request, env);
    }

    if (request.method === "POST") {
      await requireMutationAccess(request, env);
      return handleUpload(request, env);
    }

    if (request.method === "DELETE") {
      await requireMutationAccess(request, env);
      return handleBulkDelete(request, env);
    }

    return methodNotAllowed(["GET", "POST", "DELETE"]);
  }

  const imageRoutePrefix = `${API_ROUTES.images}/`;

  if (pathname.startsWith(imageRoutePrefix)) {
    const id = decodePathSegment(pathname.slice(imageRoutePrefix.length));

    if (!id) {
      throw new HttpError("Invalid image id.", 400);
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await requirePublicApiCapacity(request, env);
      return handleImage(request, id, env);
    }

    if (request.method === "DELETE") {
      await requireMutationAccess(request, env);
      return handleDelete(request, id, env);
    }

    return methodNotAllowed(["GET", "HEAD", "DELETE"]);
  }

  return json({ error: "Not found" }, 404);
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  return json({ authenticated: await isAuthenticated(request, env) });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!isAuthConfigured(env)) {
    throw new HttpError("Upload authentication is not configured.", 503);
  }

  requireContentType(request, "application/json");
  const loginKey = request.headers.get("cf-connecting-ip") || "unknown";
  const actorLimit = await env.LOGIN_RATE_LIMITER.limit({ key: `login:actor:${loginKey}` });

  if (!actorLimit.success) {
    throw new HttpError("Too many login attempts. Try again later.", 429, { "retry-after": "60" });
  }

  const payload = await readJsonBody<LoginPayload>(request, MAX_LOGIN_BODY_BYTES);

  if (typeof payload?.password !== "string" || !constantTimeEqual(payload.password, env.UPLOAD_PASSWORD || "")) {
    return json({ error: "Invalid upload password." }, 401);
  }

  const token = await createSessionToken(env);
  return json(
    { authenticated: true },
    200,
    { "set-cookie": serializeSessionCookie(token, request, SESSION_TTL_SECONDS) },
  );
}

function handleLogout(request: Request): Response {
  return json(
    { authenticated: false },
    200,
    { "set-cookie": serializeSessionCookie("", request, 0) },
  );
}

async function handleList(request: Request, env: Env): Promise<Response> {
  const snapshot = await getImageCatalog(env);
  const imageBaseUrl = resolveImageBaseUrl(request, env);
  const responseEtag = catalogResponseEtag(snapshot.etag, imageBaseUrl);
  const responseHeaders = {
    "cache-control": "public, max-age=15, must-revalidate",
    etag: responseEtag,
  };

  if (etagMatches(request.headers.get("if-none-match"), responseEtag)) {
    return new Response(null, { status: 304, headers: responseHeaders });
  }

  const images = snapshot.catalog.images.map((image) => toGalleryImage(image, imageBaseUrl));
  return json({ images, count: images.length }, 200, responseHeaders);
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  requireContentType(request, "multipart/form-data");

  if (requestBodyTooLarge(request, MAX_DIRECT_UPLOAD_BODY_BYTES)) {
    throw new HttpError("Upload request is too large.", 413);
  }

  const requestBytes = await readRequestBytes(request, MAX_DIRECT_UPLOAD_BODY_BYTES);
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: requestBytes,
  });
  let form: FormData;

  try {
    form = await boundedRequest.formData();
  } catch {
    throw new HttpError("Malformed multipart form data.", 400);
  }

  const values = [...form.getAll("images"), ...form.getAll("image")] as unknown[];
  const files = values.filter(isUploadFile);

  if (files.length === 0) {
    throw new HttpError("Upload at least one image file.", 400);
  }

  if (files.length > MAX_DIRECT_UPLOAD_FILES) {
    throw new HttpError(`Upload at most ${MAX_DIRECT_UPLOAD_FILES} images at once.`, 413);
  }

  const totalUploadBytes = files.reduce((total, file) => total + file.size, 0);

  if (totalUploadBytes > MAX_DIRECT_UPLOAD_TOTAL_BYTES) {
    throw new HttpError("Combined upload size is too large.", 413);
  }

  const clientUploadId = readClientUploadId(request);
  const prepared: PreparedUpload[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];

    if (file.size > MAX_DIRECT_UPLOAD_TOTAL_BYTES) {
      throw new HttpError(`${file.name} must use the multipart upload endpoint.`, 413);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = detectImageContentType(bytes);
    const cleanName = sanitizeUploadedFileName(file.name, contentType || file.type);

    if (bytes.byteLength !== file.size) {
      throw new HttpError(`${cleanName} has an invalid size.`, 400);
    }

    if (!contentType || !ALLOWED_TYPES.has(contentType)) {
      throw new HttpError(`${cleanName} is not a supported image type.`, 415);
    }

    const digest = base64UrlEncode(await crypto.subtle.digest("SHA-256", bytes));
    const uploadKey = `${clientUploadId}:${index + 1}`;
    const idToken = files.length === 1 ? clientUploadId : `${clientUploadId}-${index + 1}`;
    const id = createImageId(cleanName, contentType, idToken);

    prepared.push({
      bytes,
      contentType,
      digest,
      id,
      key: toStorageKey(id),
      name: cleanName,
      size: bytes.byteLength,
      uploadedAt: new Date().toISOString(),
      uploadKey,
    });
  }

  await requireImageIdsAvailable(env, prepared.map((item) => item.id));
  await reserveImageUploads(
    env,
    prepared.map((item) => ({
      clientUploadId,
      contentType: item.contentType,
      digest: item.digest,
      id: item.id,
      mode: "direct",
      name: item.name,
      reservedAt: item.uploadedAt,
      size: item.size,
    })),
  );

  const records: StoredImageRecord[] = [];
  const newKeys: string[] = [];
  const existingObjects = await Promise.all(prepared.map((item) => env.IMAGES.head(item.key)));
  const missingIndexes = existingObjects
    .map((object, index) => (object ? -1 : index))
    .filter((index) => index >= 0);

  if (missingIndexes.length > 0) {
    const catalog = await readImageCatalogFresh(env);
    const catalogIds = new Set(catalog.images.map((image) => image.id));
    const missingCatalogIds: string[] = [];

    for (const index of missingIndexes) {
      const item = prepared[index];

      if (!catalogIds.has(item.id)) {
        continue;
      }

      const raced = await env.IMAGES.head(item.key);

      if (raced) {
        existingObjects[index] = raced;
      } else {
        missingCatalogIds.push(item.id);
      }
    }

    if (missingCatalogIds.length > 0) {
      const missingIds = new Set(missingCatalogIds);
      await retireImageIds(env, missingCatalogIds);
      await mutateImageCatalog(env, (images) => images.filter((image) => !missingIds.has(image.id)));
      await releaseImageReservations(env, missingCatalogIds);
      throw new HttpError("This image id belongs to an object that is no longer available.", 410);
    }
  }

  for (let index = 0; index < prepared.length; index += 1) {
    const existing = existingObjects[index];

    if (existing && !matchesPreparedUpload(existing, prepared[index])) {
      throw new HttpError("The upload id was already used for different content.", 409);
    }
  }

  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index];
    const existing = existingObjects[index];

    if (existing) {
      records.push(toStoredImageRecord(existing));
      continue;
    }

    const stored = await env.IMAGES.put(item.key, item.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: imageHttpMetadata(item.name, item.contentType),
      customMetadata: {
        clientUploadId,
        name: item.name,
        sha256: item.digest,
        uploadedAt: item.uploadedAt,
        uploadMode: "direct",
        uploadKey: item.uploadKey,
      },
    });

    if (!stored) {
      const raced = await env.IMAGES.head(item.key);

      if (!raced || !matchesPreparedUpload(raced, item)) {
        throw new HttpError("The upload id is already in use.", 409);
      }

      records.push(toStoredImageRecord(raced));
      continue;
    }

    newKeys.push(item.key);
    records.push(toStoredImageRecord(stored));
  }

  if ((await rollbackRetiredImageRecords(env, records)).length > 0) {
    throw new HttpError("This image id was retired while the upload was being stored.", 410);
  }

  await mutateImageCatalog(env, (images) => upsertImageRecords(images, records));

  if ((await rollbackRetiredImageRecords(env, records)).length > 0) {
    throw new HttpError("This image id was retired while the upload was in progress.", 410);
  }

  const imageBaseUrl = resolveImageBaseUrl(request, env);
  const uploaded = records.map((record) => toGalleryImage(record, imageBaseUrl));
  return json({ uploaded, count: uploaded.length }, newKeys.length > 0 ? 201 : 200);
}

async function handleMultipartStart(request: Request, env: Env): Promise<Response> {
  requireContentType(request, "application/json");
  const payload = await readJsonBody<MultipartStartPayload>(request, MAX_MULTIPART_START_BODY_BYTES);

  if (typeof payload?.name !== "string" || !payload.name.trim()) {
    throw new HttpError("Upload filename is required.", 400);
  }

  if (typeof payload.contentType !== "string" || !ALLOWED_TYPES.has(payload.contentType)) {
    throw new HttpError("Unsupported image type.", 415);
  }

  if (
    typeof payload.size !== "number" ||
    !Number.isSafeInteger(payload.size) ||
    payload.size <= 0 ||
    payload.size > MAX_IMAGE_UPLOAD_BYTES
  ) {
    throw new HttpError("Upload size must be between 1 byte and 100 MB.", 413);
  }

  const clientUploadId = readClientUploadId(request);
  const cleanName = sanitizeUploadedFileName(payload.name, payload.contentType);
  const id = createImageId(cleanName, payload.contentType, clientUploadId);
  const key = toStorageKey(id);
  const stateKey = toMultipartStateKey(id);
  const uploadedAt = new Date().toISOString();
  await requireImageIdsAvailable(env, [id]);
  const existingStateBeforeReservation = await getMultipartState(env, id);

  if (existingStateBeforeReservation) {
    if (
      !multipartStartMatches(
        existingStateBeforeReservation.state,
        clientUploadId,
        cleanName,
        payload.size,
        payload.contentType,
      )
    ) {
      throw new HttpError("The upload id was already used for different content.", 409);
    }

    await ensureMultipartStateReservation(existingStateBeforeReservation.state, env);
    await requireMultipartStateActive(existingStateBeforeReservation, env);
    return json(toMultipartStartResponse(existingStateBeforeReservation.state, request, env));
  }

  const reservation: ImageUploadReservation = {
    clientUploadId,
    contentType: payload.contentType,
    id,
    mode: "multipart",
    name: cleanName,
    reservedAt: uploadedAt,
    size: payload.size,
  };
  const claimedReservations = await reserveImageUploads(env, [reservation]);
  const existingState = await getMultipartState(env, id);

  if (existingState) {
    if (!multipartStartMatches(existingState.state, clientUploadId, cleanName, payload.size, payload.contentType)) {
      throw new HttpError("The upload id was already used for different content.", 409);
    }

    await requireMultipartStateActive(existingState, env);
    return json(toMultipartStartResponse(existingState.state, request, env));
  }

  const existingImage = await env.IMAGES.head(key);

  if (existingImage) {
    throw new HttpError("This upload has already completed.", 409);
  }

  if (!claimedReservations.has(id)) {
    throw new HttpError("This multipart upload is still starting. Try again shortly.", 425, {
      "retry-after": "2",
    });
  }

  const partSize = selectChunkedUploadPartSize(payload.size);
  let upload: R2MultipartUpload;

  try {
    upload = await env.IMAGES.createMultipartUpload(key, {
      httpMetadata: imageHttpMetadata(cleanName, payload.contentType),
      customMetadata: {
        clientUploadId,
        name: cleanName,
        uploadedAt,
        uploadMode: "multipart",
        uploadKey: clientUploadId,
      },
    });
  } catch (error) {
    await releaseMatchingImageReservations(env, [reservation]);
    throw error;
  }

  const state: MultipartUploadState = {
    clientUploadId,
    contentType: payload.contentType,
    id,
    key,
    name: cleanName,
    partSize,
    size: payload.size,
    uploadedAt,
    uploadId: upload.uploadId,
  };
  let uploadHandled = false;
  let stateEtag: string | null = null;

  try {
    const stored = await env.STATE.put(stateKey, JSON.stringify(state), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "private, no-store",
      },
      customMetadata: {
        id,
        imageKey: key,
        uploadedAt,
        uploadId: upload.uploadId,
      },
    });

    if (!stored) {
      const preserved = await abortOrRememberMultipartUpload(env, upload, state);
      uploadHandled = true;
      const winner = await getMultipartState(env, id);

      if (!winner || !multipartStartMatches(winner.state, clientUploadId, cleanName, payload.size, payload.contentType)) {
        if (!preserved && !winner) {
          await releaseMatchingImageReservations(env, [reservation]);
        }

        throw new HttpError("The upload id is already in use.", 409);
      }

      await ensureMultipartStateReservation(winner.state, env);
      await requireMultipartStateActive(winner, env);
      return json(toMultipartStartResponse(winner.state, request, env));
    }

    stateEtag = stored.etag;
  } catch (error) {
    if (!uploadHandled) {
      const preserved = await abortOrRememberMultipartUpload(env, upload, state);

      if (!preserved) {
        await releaseMatchingImageReservations(env, [reservation]);
      }
    }

    throw error;
  }

  if (!stateEtag) {
    throw new Error("Multipart state was stored without an ETag.");
  }

  await requireMultipartStateActive({ bucket: env.STATE, etag: stateEtag, key: stateKey, state }, env);
  return json(toMultipartStartResponse(state, request, env), 201);
}

async function handleMultipartPart(
  request: Request,
  env: Env,
  id: string,
  partNumber: number,
): Promise<Response> {
  if (!isValidImageId(id)) {
    throw new HttpError("Invalid upload id.", 400);
  }

  await requireImageIdsAvailable(env, [id]);
  const location = await getMultipartState(env, id);

  if (!location) {
    throw new HttpError("Multipart upload was not found.", 404);
  }

  const state = location.state;
  const uploadId = new URL(request.url).searchParams.get("uploadId");

  if (!uploadId || uploadId !== state.uploadId) {
    throw new HttpError("Multipart upload id is invalid.", 400);
  }

  const expectedPartCount = Math.ceil(state.size / state.partSize);

  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expectedPartCount) {
    throw new HttpError("Invalid upload part number.", 400);
  }

  const expectedBytes =
    partNumber === expectedPartCount ? state.size - state.partSize * (expectedPartCount - 1) : state.partSize;
  const upload = env.IMAGES.resumeMultipartUpload(state.key, state.uploadId);
  let part: R2UploadedPart;

  try {
    part = await uploadMultipartRequestPart(
      request,
      upload,
      partNumber,
      expectedBytes,
      partNumber === 1 ? state.contentType : undefined,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 415) {
      try {
        await upload.abort();
      } catch {
        throw new HttpError("The invalid multipart upload could not be aborted. Try again later.", 503);
      }

      await removeMultipartState(location);
      await releaseMatchingImageReservations(env, [multipartReservationExpectation(state)]);
      throw new HttpError(`${state.name} does not match its declared image type.`, 415);
    }

    throw error;
  }

  return json({ part });
}

async function uploadMultipartRequestPart(
  request: Request,
  upload: R2MultipartUpload,
  partNumber: number,
  expectedBytes: number,
  expectedContentType?: string,
): Promise<R2UploadedPart> {
  const contentLength = parseContentLength(request.headers.get("content-length"));

  if (contentLength !== null && contentLength !== expectedBytes) {
    throw new HttpError("Upload part size does not match the declared file size.", 400);
  }

  if (!request.body) {
    throw new HttpError("Upload part is empty.", 400);
  }

  const prefix = expectedContentType
    ? new Uint8Array(Math.min(IMAGE_SIGNATURE_BYTES, expectedBytes))
    : null;
  let prefixBytes = 0;
  let receivedBytes = 0;
  let validationError: HttpError | null = null;
  let streamError: HttpError | null = null;
  const exactBody = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;

        if (receivedBytes > expectedBytes) {
          streamError = new HttpError("Upload part size does not match the declared file size.", 400);
          controller.error(streamError);
          return;
        }

        if (prefix && prefixBytes < prefix.byteLength) {
          const bytesToCopy = Math.min(prefix.byteLength - prefixBytes, chunk.byteLength);
          prefix.set(chunk.subarray(0, bytesToCopy), prefixBytes);
          prefixBytes += bytesToCopy;

          if (prefixBytes < prefix.byteLength) {
            return;
          }

          if (detectImageContentType(prefix) !== expectedContentType) {
            validationError = new HttpError("Upload content does not match its declared image type.", 415);
            controller.error(validationError);
            return;
          }

          controller.enqueue(prefix);

          if (bytesToCopy < chunk.byteLength) {
            controller.enqueue(chunk.subarray(bytesToCopy));
          }

          return;
        }

        controller.enqueue(chunk);
      },
      flush() {
        if (receivedBytes !== expectedBytes) {
          streamError = new HttpError("Upload part size does not match the declared file size.", 400);
          throw streamError;
        }
      },
    }),
  );
  const fixedLengthBody = new FixedLengthStream(expectedBytes);
  const pipePromise = exactBody.pipeTo(fixedLengthBody.writable);

  try {
    const [part] = await Promise.all([
      upload.uploadPart(partNumber, fixedLengthBody.readable),
      pipePromise,
    ]);
    return part;
  } catch (error) {
    throw validationError || streamError || error;
  }
}

async function handleMultipartComplete(request: Request, env: Env, id: string): Promise<Response> {
  if (!isValidImageId(id)) {
    throw new HttpError("Invalid upload id.", 400);
  }

  requireContentType(request, "application/json");
  const payload = await readJsonBody<MultipartCompletePayload>(request, MAX_MULTIPART_COMPLETE_BODY_BYTES);
  const location = await getMultipartState(env, id);

  if (!location) {
    const completed = await env.IMAGES.head(toStorageKey(id));

    if (!completed) {
      throw new HttpError("Multipart upload was not found.", 404);
    }

    if (completed.customMetadata?.uploadMode === "direct") {
      throw new HttpError("Stored object does not belong to a multipart upload.", 409);
    }

    if (await removeRetiredImage(env, id)) {
      throw new HttpError("This image id has been retired.", 410);
    }

    const record = toStoredImageRecord(completed);
    await mutateImageCatalog(env, (images) => upsertImageRecords(images, [record]));

    if (await removeRetiredImage(env, id)) {
      throw new HttpError("This image id was retired while the upload was being recovered.", 410);
    }

    return json({ image: toGalleryImage(record, resolveImageBaseUrl(request, env)) });
  }

  const state = location.state;

  if (await isImageRetired(env, state.id)) {
    await abortMultipartState(location, env);
    throw new HttpError("This image id has been retired.", 410);
  }

  if (payload?.uploadId !== state.uploadId) {
    throw new HttpError("Multipart upload id is invalid.", 400);
  }

  const alreadyCompleted = await env.IMAGES.head(state.key);

  if (alreadyCompleted) {
    return finalizeMultipartUpload(request, env, location, alreadyCompleted);
  }

  const parts = parseUploadedParts(payload.parts);

  if (!parts.length || !partsMatchUpload(parts, state)) {
    throw new HttpError("Upload parts do not match the declared file size.", 400);
  }

  const object = await env.IMAGES.resumeMultipartUpload(state.key, state.uploadId).complete(parts);

  if (object.size !== state.size) {
    await env.IMAGES.delete(state.key);
    await removeMultipartState(location);
    await releaseMatchingImageReservations(env, [multipartReservationExpectation(state)]);
    throw new HttpError("Completed upload size does not match the declared file size.", 400);
  }

  return finalizeMultipartUpload(request, env, location, object);
}

async function finalizeMultipartUpload(
  request: Request,
  env: Env,
  location: MultipartStateLocation,
  object: R2Object,
): Promise<Response> {
  const state = location.state;

  if (await removeRetiredImage(env, state.id)) {
    await removeMultipartState(location);
    throw new HttpError("This image id has been retired.", 410);
  }

  if (!matchesMultipartObject(object, state)) {
    throw new HttpError("Stored upload metadata does not match the upload session.", 409);
  }

  const record = toStoredImageRecord(object);
  await mutateImageCatalog(env, (images) => upsertImageRecords(images, [record]));

  if (await removeRetiredImage(env, state.id)) {
    await removeMultipartState(location);
    throw new HttpError("This image id was retired while the upload was being completed.", 410);
  }

  await removeMultipartState(location);
  return json({ image: toGalleryImage(record, resolveImageBaseUrl(request, env)) });
}

async function handleMultipartAbort(request: Request, env: Env, id: string): Promise<Response> {
  if (!isValidImageId(id)) {
    throw new HttpError("Invalid upload id.", 400);
  }

  const location = await getMultipartState(env, id);

  if (!location) {
    return json({ ok: true });
  }

  const uploadId = new URL(request.url).searchParams.get("uploadId");

  if (uploadId && uploadId !== location.state.uploadId) {
    throw new HttpError("Multipart upload id is invalid.", 400);
  }

  const completed = await env.IMAGES.head(location.state.key);

  if (completed) {
    if (location.state.orphaned || !matchesMultipartObject(completed, location.state)) {
      try {
        await env.IMAGES.resumeMultipartUpload(location.state.key, location.state.uploadId).abort();
      } catch {
        throw new HttpError("The multipart upload could not be aborted. Try again later.", 503);
      }

      await removeMultipartState(location);
      await releaseMatchingImageReservations(env, [multipartReservationExpectation(location.state)]);
      return json({ ok: true });
    }

    if (await removeRetiredImage(env, location.state.id)) {
      await removeMultipartState(location);
      return json({ ok: true, retired: true });
    }

    const record = toStoredImageRecord(completed);
    await mutateImageCatalog(env, (images) => upsertImageRecords(images, [record]));

    if (await removeRetiredImage(env, location.state.id)) {
      await removeMultipartState(location);
      return json({ ok: true, retired: true });
    }

    await removeMultipartState(location);
    return json({ ok: true, completed: true });
  }

  try {
    await env.IMAGES.resumeMultipartUpload(location.state.key, location.state.uploadId).abort();
  } catch {
    throw new HttpError("The multipart upload could not be aborted. Try again later.", 503);
  }

  await removeMultipartState(location);
  await releaseMatchingImageReservations(env, [multipartReservationExpectation(location.state)]);
  return json({ ok: true });
}

async function handleImage(request: Request, id: string, env: Env): Promise<Response> {
  if (!isValidImageId(id)) {
    throw new HttpError("Invalid image id.", 400);
  }

  const publicUrl = resolveConfiguredImageUrl(request, env, id);

  if (publicUrl) {
    return new Response(null, {
      status: 308,
      headers: {
        "cache-control": "public, max-age=86400, immutable",
        location: publicUrl,
        "referrer-policy": "no-referrer",
      },
    });
  }

  const key = toStorageKey(id);
  const object = request.method === "HEAD" ? await env.IMAGES.head(key) : await env.IMAGES.get(key);

  if (!object) {
    return json({ error: "Image not found." }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", headers.get("cache-control") || IMAGE_CACHE_CONTROL);
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("x-content-type-options", "nosniff");

  if (etagMatches(request.headers.get("if-none-match"), object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  const body: BodyInit | null =
    request.method === "HEAD" || !("body" in object) ? null : (object as R2ObjectBody).body;
  return new Response(body, { headers });
}

async function handleDelete(_request: Request, id: string, env: Env): Promise<Response> {
  if (!isValidImageId(id)) {
    throw new HttpError("Invalid image id.", 400);
  }

  const pending = await getMultipartState(env, id);

  if (pending) {
    await retireImageIds(env, [id]);
    await abortMultipartState(pending, env);
    return json({ ok: true });
  }

  const reserved = (await findPendingImageReservationIds(env, [id])).length > 0;
  const snapshot = await getImageCatalog(env);
  const cataloged = snapshot.catalog.images.some((image) => image.id === id);
  const stored = cataloged ? null : await env.IMAGES.head(toStorageKey(id));
  const shouldRetire = reserved || cataloged || Boolean(stored);

  if (!shouldRetire) {
    return json({ ok: true });
  }

  await retireImageIds(env, [id]);
  await env.IMAGES.delete(toStorageKey(id));
  await mutateImageCatalog(env, (images) => images.filter((image) => image.id !== id));
  await releaseImageReservations(env, [id]);

  return json({ ok: true });
}

async function handleBulkDelete(request: Request, env: Env): Promise<Response> {
  requireContentType(request, "application/json");
  const payload = await readJsonBody<DeleteImagesPayload>(request, MAX_DELETE_BODY_BYTES);
  const ids = parseDeleteImageIds(payload);
  const pendingIds = await findPendingImageReservationIds(env, ids);

  if (pendingIds.length > 0) {
    throw new HttpError("Pending upload ids cannot be bulk deleted.", 409);
  }

  // Uploads commit the catalog before releasing their reservation. Reading in this
  // order prevents a completion transition from disappearing between snapshots.
  const catalog = await readImageCatalogFresh(env);
  const catalogIds = new Set(catalog.images.map((image) => image.id));
  const uncatalogedIds = ids.filter((id) => !catalogIds.has(id));
  const storedIds = new Set(
    (
      await Promise.all(
        uncatalogedIds.map(async (id) => ((await env.IMAGES.head(toStorageKey(id))) ? id : null)),
      )
    ).filter((id): id is string => id !== null),
  );
  const idsToRetire = ids.filter((id) => catalogIds.has(id) || storedIds.has(id));

  if (idsToRetire.length === 0) {
    return json({ ok: true, deleted: ids, count: ids.length });
  }

  await retireImageIds(env, idsToRetire);
  await deleteImageIds(idsToRetire, env);
  const deleted = new Set(idsToRetire);
  await mutateImageCatalog(env, (images) => images.filter((image) => !deleted.has(image.id)));
  await releaseImageReservations(env, idsToRetire);
  return json({ ok: true, deleted: ids, count: ids.length });
}

async function deleteImageIds(ids: string[], env: Env): Promise<void> {
  const batches: string[][] = [];

  for (let index = 0; index < ids.length; index += R2_DELETE_BATCH_SIZE) {
    batches.push(ids.slice(index, index + R2_DELETE_BATCH_SIZE).map(toStorageKey));
  }

  await Promise.all(batches.map((keys) => env.IMAGES.delete(keys)));
}

function parseDeleteImageIds(payload: DeleteImagesPayload | null): string[] {
  if (!payload || !Array.isArray(payload.ids)) {
    throw new HttpError("Provide image ids to delete.", 400);
  }

  if (payload.ids.length > MAX_DELETE_IMAGE_IDS_PER_REQUEST) {
    throw new HttpError(`Delete at most ${MAX_DELETE_IMAGE_IDS_PER_REQUEST} images at a time.`, 400);
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (const id of payload.ids) {
    if (typeof id !== "string" || !isValidImageId(id)) {
      throw new HttpError("Delete request contains an invalid image id.", 400);
    }

    if (!seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }

  if (ids.length === 0) {
    throw new HttpError("Select at least one image to delete.", 400);
  }

  return ids;
}

async function handleRandom(request: Request, env: Env): Promise<Response> {
  const snapshot = await getImageCatalog(env);

  if (snapshot.catalog.images.length === 0) {
    return json({ error: "No uploaded images are available yet." }, 404);
  }

  const stored = snapshot.catalog.images[Math.floor(Math.random() * snapshot.catalog.images.length)];
  const image = toGalleryImage(stored, resolveImageBaseUrl(request, env));
  const url = new URL(request.url);

  if (url.searchParams.get("format") === "json") {
    return json({ image });
  }

  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location: image.url,
      "referrer-policy": "no-referrer",
    },
  });
}

async function getImageCatalog(env: Env): Promise<CatalogSnapshot> {
  if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) {
    return cachedCatalog;
  }

  for (let attempt = 0; attempt < CATALOG_MUTATION_ATTEMPTS; attempt += 1) {
    const object = await env.STATE.get(IMAGE_CATALOG_KEY);
    const catalog = object ? await parseImageCatalogObject(object) : null;

    if (object && catalog) {
      return cacheCatalog(catalog, object);
    }

    const images = await scanImageRecords(env);
    const nextCatalog = createImageCatalog(images);
    const stored = await putImageCatalog(env, nextCatalog, object?.etag);

    if (stored) {
      await releaseImageReservations(
        env,
        images.map((image) => image.id),
      );
      return cacheCatalog(nextCatalog, stored);
    }

    await shortRetryDelay(attempt);
  }

  throw new Error("Image catalog initialization did not converge.");
}

async function reserveImageUploads(
  env: Env,
  candidates: ImageUploadReservation[],
  renewStale = true,
): Promise<Set<string>> {
  const candidatesById = new Map<string, ImageUploadReservation>();

  for (const candidate of candidates) {
    const existing = candidatesById.get(candidate.id);

    if (existing && !imageUploadReservationsMatch(existing, candidate)) {
      throw new HttpError("The request contains conflicting upload reservations.", 409);
    }

    candidatesById.set(candidate.id, candidate);
  }

  for (let attempt = 0; attempt < CATALOG_MUTATION_ATTEMPTS; attempt += 1) {
    const object = await env.STATE.get(IMAGE_RESERVATIONS_KEY);
    const current = object ? await parseImageReservationsObject(object) : createImageReservations([]);

    if (!current) {
      throw new Error("The image reservation registry is invalid.");
    }

    // Read the catalog after the registry. Catalog commits happen before reservation release,
    // so this order cannot observe a released slot without its committed image.
    const catalog = await readImageCatalogFresh(env);
    const catalogIds = new Set(catalog.images.map((image) => image.id));
    const pending = current.uploads.filter((upload) => !catalogIds.has(upload.id));
    const uploadsById = new Map(pending.map((upload) => [upload.id, upload]));
    const claimedIds = new Set<string>();

    for (const candidate of candidatesById.values()) {
      if (catalogIds.has(candidate.id)) {
        continue;
      }

      const existing = uploadsById.get(candidate.id);

      if (existing && !imageUploadReservationsMatch(existing, candidate)) {
        throw new HttpError("The upload id is already reserved for different content.", 409);
      }

      if (!existing) {
        uploadsById.set(candidate.id, candidate);
        claimedIds.add(candidate.id);
      } else if (
        renewStale &&
        Date.parse(existing.reservedAt) <=
        Date.now() -
          (candidate.mode === "direct" ? STALE_DIRECT_UPLOAD_MS : MULTIPART_RESERVATION_LEASE_MS)
      ) {
        uploadsById.set(candidate.id, { ...existing, reservedAt: candidate.reservedAt });
        claimedIds.add(candidate.id);
      }
    }

    const nextUploads = sortImageReservations([...uploadsById.values()]);
    const multipartCount = nextUploads.filter((upload) => upload.mode === "multipart").length;
    const catalogBytes = catalog.images.reduce((total, image) => total + image.size, 0);
    const pendingBytes = nextUploads.reduce((total, upload) => total + upload.size, 0);

    if (multipartCount > MAX_ACTIVE_MULTIPART_UPLOADS) {
      throw new HttpError(`At most ${MAX_ACTIVE_MULTIPART_UPLOADS} multipart uploads may be active.`, 409);
    }

    if (nextUploads.length > MAX_PENDING_IMAGE_RESERVATIONS) {
      throw new HttpError("Too many image uploads are pending. Try again after cleanup runs.", 409);
    }

    if (pendingBytes > MAX_PENDING_UPLOAD_BYTES) {
      throw new HttpError("Pending uploads are limited to 512 MiB.", 507);
    }

    if (
      catalog.images.length + nextUploads.length > MAX_CATALOG_IMAGES ||
      catalogBytes + pendingBytes > MAX_GALLERY_BYTES
    ) {
      throw new HttpError(`Gallery capacity is limited to ${MAX_CATALOG_IMAGES} images or 9 GB.`, 507);
    }

    if (imageReservationsEqual(current.uploads, nextUploads)) {
      return claimedIds;
    }

    const stored = await putImageReservations(env, createImageReservations(nextUploads), object?.etag);

    if (stored) {
      return claimedIds;
    }

    await shortRetryDelay(attempt);
  }

  throw new Error("Concurrent image capacity reservations did not converge.");
}

async function ensureMultipartStateReservation(
  state: MultipartUploadState,
  env: Env,
): Promise<void> {
  if (!state.clientUploadId) {
    return;
  }

  await reserveImageUploads(
    env,
    [
      {
        clientUploadId: state.clientUploadId,
        contentType: state.contentType,
        id: state.id,
        mode: "multipart",
        name: state.name,
        reservedAt: state.uploadedAt,
        size: state.size,
      },
    ],
    false,
  );
}

async function releaseImageReservations(env: Env, ids: string[]): Promise<void> {
  const releasedIds = new Set(ids);

  if (releasedIds.size === 0) {
    return;
  }

  for (let attempt = 0; attempt < CATALOG_MUTATION_ATTEMPTS; attempt += 1) {
    const object = await env.STATE.get(IMAGE_RESERVATIONS_KEY);

    if (!object) {
      return;
    }

    const current = await parseImageReservationsObject(object);

    if (!current) {
      throw new Error("The image reservation registry is invalid.");
    }

    const nextUploads = current.uploads.filter((upload) => !releasedIds.has(upload.id));

    if (nextUploads.length === current.uploads.length) {
      return;
    }

    const stored = await putImageReservations(env, createImageReservations(nextUploads), object.etag);

    if (stored) {
      return;
    }

    await shortRetryDelay(attempt);
  }

  throw new Error("Concurrent image reservation releases did not converge.");
}

async function releaseMatchingImageReservations(
  env: Env,
  expectations: ImageReservationExpectation[],
): Promise<void> {
  if (expectations.length === 0) {
    return;
  }

  const expectationsById = new Map<string, ImageReservationExpectation[]>();

  for (const expectation of expectations) {
    expectationsById.set(expectation.id, [
      ...(expectationsById.get(expectation.id) ?? []),
      expectation,
    ]);
  }

  for (let attempt = 0; attempt < CATALOG_MUTATION_ATTEMPTS; attempt += 1) {
    const object = await env.STATE.get(IMAGE_RESERVATIONS_KEY);

    if (!object) {
      return;
    }

    const current = await parseImageReservationsObject(object);

    if (!current) {
      throw new Error("The image reservation registry is invalid.");
    }

    const nextUploads = current.uploads.filter((upload) => {
      const candidates = expectationsById.get(upload.id);
      return !candidates?.some((expectation) => imageReservationMatchesExpectation(upload, expectation));
    });

    if (nextUploads.length === current.uploads.length) {
      return;
    }

    const stored = await putImageReservations(env, createImageReservations(nextUploads), object.etag);

    if (stored) {
      return;
    }

    await shortRetryDelay(attempt);
  }

  throw new Error("Concurrent image reservation releases did not converge.");
}

function imageReservationMatchesExpectation(
  reservation: ImageUploadReservation,
  expectation: ImageReservationExpectation,
): boolean {
  return (
    reservation.id === expectation.id &&
    reservation.mode === expectation.mode &&
    reservation.reservedAt === expectation.reservedAt &&
    (expectation.clientUploadId === undefined ||
      reservation.clientUploadId === expectation.clientUploadId)
  );
}

function multipartReservationExpectation(state: MultipartUploadState): ImageReservationExpectation {
  return {
    clientUploadId: state.clientUploadId,
    id: state.id,
    mode: "multipart",
    reservedAt: state.uploadedAt,
  };
}

async function findPendingImageReservationIds(env: Env, ids: string[]): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }

  const object = await env.STATE.get(IMAGE_RESERVATIONS_KEY);

  if (!object) {
    return [];
  }

  const reservations = await parseImageReservationsObject(object);

  if (!reservations) {
    throw new Error("The image reservation registry is invalid.");
  }

  const pendingIds = new Set(reservations.uploads.map((upload) => upload.id));
  return ids.filter((id) => pendingIds.has(id));
}

async function cleanupStaleImageReservations(env: Env): Promise<void> {
  const object = await env.STATE.get(IMAGE_RESERVATIONS_KEY);

  if (!object) {
    return;
  }

  const reservations = await parseImageReservationsObject(object);

  if (!reservations) {
    throw new Error("The image reservation registry is invalid.");
  }

  const catalog = await readImageCatalogFresh(env);
  const catalogIds = new Set(catalog.images.map((image) => image.id));
  const releaseExpectations: ImageReservationExpectation[] = reservations.uploads.filter((upload) =>
    catalogIds.has(upload.id),
  );
  const now = Date.now();
  const stale = reservations.uploads
    .filter(
      (upload) =>
        !catalogIds.has(upload.id) &&
        Date.parse(upload.reservedAt) <=
          now - (upload.mode === "direct" ? STALE_DIRECT_UPLOAD_MS : STALE_MULTIPART_UPLOAD_MS),
    )
    .slice(0, 8);
  const recoveredRecords: StoredImageRecord[] = [];

  for (const upload of stale) {
    if (upload.mode === "multipart" && (await getMultipartState(env, upload.id))) {
      continue;
    }

    const stored = await env.IMAGES.head(toStorageKey(upload.id));

    if (!stored) {
      releaseExpectations.push(upload);
      continue;
    }

    if (await isImageRetired(env, upload.id)) {
      await env.IMAGES.delete(toStorageKey(upload.id));
      releaseExpectations.push(upload);
      continue;
    }

    if (!matchesImageReservationObject(stored, upload)) {
      await retireImageIds(env, [upload.id]);
      await env.IMAGES.delete(toStorageKey(upload.id));
      releaseExpectations.push(upload);
      continue;
    }

    recoveredRecords.push(toStoredImageRecord(stored));
  }

  if (recoveredRecords.length > 0) {
    await mutateImageCatalog(env, (images) => upsertImageRecords(images, recoveredRecords));
    await rollbackRetiredImageRecords(env, recoveredRecords);
  }

  await releaseMatchingImageReservations(env, releaseExpectations);
}

async function assertImageCapacity(env: Env, images: StoredImageRecord[]): Promise<void> {
  const object = await env.STATE.get(IMAGE_RESERVATIONS_KEY);
  const reservations = object ? await parseImageReservationsObject(object) : createImageReservations([]);

  if (!reservations) {
    throw new Error("The image reservation registry is invalid.");
  }

  const imageIds = new Set(images.map((image) => image.id));
  const pending = reservations.uploads.filter((upload) => !imageIds.has(upload.id));
  const pendingBytes = pending.reduce((total, upload) => total + upload.size, 0);
  const imageBytes = images.reduce((total, image) => total + image.size, 0);

  if (
    images.length > MAX_CATALOG_IMAGES ||
    images.length + pending.length > MAX_CATALOG_IMAGES ||
    pendingBytes > MAX_PENDING_UPLOAD_BYTES ||
    imageBytes + pendingBytes > MAX_GALLERY_BYTES
  ) {
    throw new HttpError(`Gallery capacity is limited to ${MAX_CATALOG_IMAGES} images or 9 GB.`, 507);
  }
}

async function readImageCatalogFresh(env: Env): Promise<ImageCatalog> {
  const object = await env.STATE.get(IMAGE_CATALOG_KEY);
  const catalog = object ? await parseImageCatalogObject(object) : null;

  if (catalog) {
    return catalog;
  }

  cachedCatalog = null;
  return (await getImageCatalog(env)).catalog;
}

async function mutateImageCatalog(
  env: Env,
  mutate: (images: StoredImageRecord[]) => StoredImageRecord[],
): Promise<CatalogSnapshot> {
  for (let attempt = 0; attempt < CATALOG_MUTATION_ATTEMPTS; attempt += 1) {
    const object = await env.STATE.get(IMAGE_CATALOG_KEY);
    const currentCatalog = object ? await parseImageCatalogObject(object) : null;
    const currentImages = currentCatalog?.images ?? (await scanImageRecords(env));
    const nextImages = sortImageRecords(mutate([...currentImages]));

    if (!isMonotonicCatalogReduction(currentImages, nextImages)) {
      await assertImageCapacity(env, nextImages);
    }

    if (currentCatalog && imageRecordsEqual(currentCatalog.images, nextImages)) {
      await releaseImageReservations(
        env,
        nextImages.map((image) => image.id),
      );
      return cacheCatalog(currentCatalog, object!);
    }

    const nextCatalog = createImageCatalog(nextImages);
    const stored = await putImageCatalog(env, nextCatalog, object?.etag);

    if (stored) {
      await releaseImageReservations(
        env,
        nextImages.map((image) => image.id),
      );
      return cacheCatalog(nextCatalog, stored);
    }

    cachedCatalog = null;
    await shortRetryDelay(attempt);
  }

  throw new Error("Concurrent catalog updates did not converge.");
}

function isMonotonicCatalogReduction(
  currentImages: StoredImageRecord[],
  nextImages: StoredImageRecord[],
): boolean {
  const currentIds = new Set(currentImages.map((image) => image.id));
  const currentBytes = currentImages.reduce((total, image) => total + image.size, 0);
  const nextBytes = nextImages.reduce((total, image) => total + image.size, 0);
  return (
    nextImages.length <= currentImages.length &&
    nextBytes <= currentBytes &&
    nextImages.every((image) => currentIds.has(image.id))
  );
}

async function reconcileImageCatalogPage(env: Env): Promise<void> {
  await reconcileStoredImagePage(env);
  await reconcileCatalogRecordPage(env);
}

async function reconcileStoredImagePage(env: Env): Promise<void> {
  const cursor = await readCleanupCursor(env, STORED_IMAGE_RECONCILIATION_CURSOR_KEY);
  const options: R2ListWithMetadataOptions = {
    prefix: IMAGE_PREFIX,
    cursor,
    limit: IMAGE_RECONCILIATION_PAGE_SIZE,
    include: ["httpMetadata", "customMetadata"],
  };
  let listed: R2Objects;

  try {
    listed = await env.IMAGES.list(options);
  } catch (error) {
    if (!cursor) {
      throw error;
    }

    await env.STATE.delete(STORED_IMAGE_RECONCILIATION_CURSOR_KEY);
    listed = await env.IMAGES.list({ ...options, cursor: undefined });
  }

  const records = listed.objects
    .map(toStoredImageRecordOrNull)
    .filter((record): record is StoredImageRecord => record !== null);

  if (records.length > 0) {
    const retiredIds = new Set(await rollbackRetiredImageRecords(env, records));
    const activeRecords = records.filter((record) => !retiredIds.has(record.id));

    if (activeRecords.length > 0) {
      await mutateImageCatalog(env, (images) => upsertImageRecords(images, activeRecords));
      await rollbackRetiredImageRecords(env, activeRecords);
    }
  }

  await writeMaintenanceCursor(
    env,
    STORED_IMAGE_RECONCILIATION_CURSOR_KEY,
    listed.truncated ? listed.cursor : undefined,
  );
}

async function reconcileCatalogRecordPage(env: Env): Promise<void> {
  const catalog = await readImageCatalogFresh(env);

  if (catalog.images.length === 0) {
    await env.STATE.delete(CATALOG_RECONCILIATION_OFFSET_KEY);
    return;
  }

  const storedOffset = Number(await readCleanupCursor(env, CATALOG_RECONCILIATION_OFFSET_KEY));
  const offset = Number.isSafeInteger(storedOffset) && storedOffset >= 0 && storedOffset < catalog.images.length
    ? storedOffset
    : 0;
  const records = catalog.images.slice(offset, offset + IMAGE_RECONCILIATION_PAGE_SIZE);
  const objects = await Promise.all(records.map((record) => env.IMAGES.head(toStorageKey(record.id))));
  const missingIds = new Set(
    records
      .filter((_record, index) => !objects[index] || !toStoredImageRecordOrNull(objects[index]!))
      .map((record) => record.id),
  );

  if (missingIds.size > 0) {
    await retireImageIds(env, [...missingIds]);
    await mutateImageCatalog(env, (images) => images.filter((image) => !missingIds.has(image.id)));
    await releaseImageReservations(env, [...missingIds]);
  }

  const nextOffset = offset + records.length >= catalog.images.length ? 0 : offset + records.length;
  await writeMaintenanceCursor(env, CATALOG_RECONCILIATION_OFFSET_KEY, String(nextOffset));
}

async function scanImageRecords(env: Env): Promise<StoredImageRecord[]> {
  const images: StoredImageRecord[] = [];
  let cursor: string | undefined;

  do {
    const options: R2ListWithMetadataOptions = {
      prefix: IMAGE_PREFIX,
      cursor,
      limit: 1_000,
      include: ["httpMetadata", "customMetadata"],
    };
    const result = await env.IMAGES.list(options);

    for (const object of result.objects) {
      const image = toStoredImageRecordOrNull(object);

      if (!image) {
        continue;
      }

      images.push(image);

      if (images.length > MAX_SCANNED_IMAGE_OBJECTS) {
        throw new HttpError(`Gallery storage contains more than ${MAX_SCANNED_IMAGE_OBJECTS} image objects.`, 507);
      }
    }

    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  const retiredIds = await listRetiredImageIds(env);
  const storedRetiredIds = images.filter((image) => retiredIds.has(image.id)).map((image) => image.id);

  if (storedRetiredIds.length > 0) {
    await deleteImageIds(storedRetiredIds, env);
    await releaseImageReservations(env, storedRetiredIds);
  }

  const activeImages = images.filter((image) => !retiredIds.has(image.id));

  if (activeImages.length > MAX_READABLE_CATALOG_IMAGES) {
    throw new HttpError(`Gallery storage contains more than ${MAX_READABLE_CATALOG_IMAGES} active images.`, 507);
  }

  return sortImageRecords(activeImages);
}

async function listRetiredImageIds(env: Env): Promise<Set<string>> {
  const retiredIds = new Set<string>();
  const activeAfter = Date.now() - RETIRED_IMAGE_TTL_MS;

  for (let shard = 0; shard < LEGACY_RETIRED_IMAGE_SHARD_COUNT; shard += 1) {
    const retired = await readLegacyRetiredImageShard(env, shard);

    for (const image of retired.images) {
      if (Date.parse(image.retiredAt) > activeAfter) {
        retiredIds.add(image.id);
      }
    }
  }

  let cursor: string | undefined;
  let scannedMarkers = 0;

  do {
    const listed = await env.STATE.list({
      prefix: RETIRED_IMAGE_MARKER_PREFIX,
      cursor,
      limit: 1_000,
      include: ["customMetadata"],
    } as R2ListWithMetadataOptions);

    for (const object of listed.objects) {
      scannedMarkers += 1;

      if (scannedMarkers > MAX_RETIRED_MARKERS_FOR_CATALOG_REBUILD) {
        throw new HttpError("Too many retired image markers to rebuild the catalog safely.", 507);
      }

      const id = object.key.slice(RETIRED_IMAGE_MARKER_PREFIX.length);

      if (isValidImageId(id) && isRetiredImageMarkerActive(object, activeAfter)) {
        retiredIds.add(id);
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return retiredIds;
}

async function parseImageCatalogObject(object: R2ObjectBody): Promise<ImageCatalog | null> {
  if (object.size > MAX_CATALOG_BYTES) {
    return null;
  }

  try {
    const value = await object.json<unknown>();
    return isImageCatalog(value) ? value : null;
  } catch {
    return null;
  }
}

async function parseImageReservationsObject(object: R2ObjectBody): Promise<ImageUploadReservations | null> {
  if (object.size > MAX_IMAGE_RESERVATIONS_BYTES) {
    return null;
  }

  try {
    const value = await object.json<unknown>();

    if (typeof value !== "object" || value === null) {
      return null;
    }

    const registry = value as Record<string, unknown>;

    if (
      registry.version !== IMAGE_RESERVATIONS_VERSION ||
      !Array.isArray(registry.uploads) ||
      registry.uploads.length > MAX_PENDING_IMAGE_RESERVATIONS ||
      !registry.uploads.every(isImageUploadReservation)
    ) {
      return null;
    }

    const uploads = registry.uploads as ImageUploadReservation[];
    return new Set(uploads.map((upload) => upload.id)).size === uploads.length
      ? createImageReservations(uploads)
      : null;
  } catch {
    return null;
  }
}

async function parseRetiredImagesObject(object: R2ObjectBody): Promise<RetiredImages | null> {
  if (object.size > MAX_LEGACY_RETIRED_IMAGE_SHARD_BYTES) {
    return null;
  }

  try {
    const value = await object.json<unknown>();

    if (typeof value !== "object" || value === null) {
      return null;
    }

    const registry = value as Record<string, unknown>;

    if (
      registry.version !== LEGACY_RETIRED_IMAGES_VERSION ||
      !Array.isArray(registry.images) ||
      registry.images.length > MAX_LEGACY_RETIRED_IMAGES_PER_SHARD ||
      !registry.images.every(isRetiredImageRecord)
    ) {
      return null;
    }

    const images = registry.images as RetiredImageRecord[];
    return new Set(images.map((image) => image.id)).size === images.length
      ? createRetiredImages(images)
      : null;
  } catch {
    return null;
  }
}

function isRetiredImageRecord(value: unknown): value is RetiredImageRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const image = value as Record<string, unknown>;
  return (
    typeof image.id === "string" &&
    isValidImageId(image.id) &&
    typeof image.retiredAt === "string" &&
    Number.isFinite(Date.parse(image.retiredAt))
  );
}

function createRetiredImages(images: RetiredImageRecord[]): RetiredImages {
  return {
    version: LEGACY_RETIRED_IMAGES_VERSION,
    images: images.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function retiredImageMarkerKey(id: string): string {
  return `${RETIRED_IMAGE_MARKER_PREFIX}${id}`;
}

function isRetiredImageMarkerActive(object: R2Object, activeAfter: number): boolean {
  const retiredAt = Date.parse(object.customMetadata?.retiredAt || "");
  return !Number.isFinite(retiredAt) || retiredAt > activeAfter;
}

function legacyRetiredImageShardIndex(id: string): number {
  let hash = 2166136261;

  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % LEGACY_RETIRED_IMAGE_SHARD_COUNT;
}

function legacyRetiredImageShardKey(shard: number): string {
  return `${LEGACY_RETIRED_IMAGES_KEY_PREFIX}${shard.toString(16).padStart(2, "0")}.json`;
}

async function readLegacyRetiredImageShard(env: Env, shard: number): Promise<RetiredImages> {
  const object = await env.STATE.get(legacyRetiredImageShardKey(shard));
  const retired = object ? await parseRetiredImagesObject(object) : createRetiredImages([]);

  if (!retired) {
    throw new Error(`Retired image shard ${shard} is invalid.`);
  }

  return retired;
}

async function putRetiredImages(
  env: Env,
  key: string,
  retired: RetiredImages,
  expectedEtag?: string,
): Promise<R2Object | null> {
  return env.STATE.put(key, JSON.stringify(retired), {
    onlyIf: expectedEtag ? { etagMatches: expectedEtag } : { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, no-store",
    },
  });
}

function isImageUploadReservation(value: unknown): value is ImageUploadReservation {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const upload = value as Record<string, unknown>;
  const directDigestIsValid =
    upload.mode === "direct" &&
    typeof upload.digest === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(upload.digest);
  const multipartDigestIsValid = upload.mode === "multipart" && upload.digest === undefined;

  return (
    typeof upload.clientUploadId === "string" &&
    CLIENT_UPLOAD_ID_PATTERN.test(upload.clientUploadId) &&
    typeof upload.contentType === "string" &&
    ALLOWED_TYPES.has(upload.contentType) &&
    (directDigestIsValid || multipartDigestIsValid) &&
    typeof upload.id === "string" &&
    isValidImageId(upload.id) &&
    typeof upload.name === "string" &&
    upload.name.length > 0 &&
    upload.name.length <= 160 &&
    typeof upload.reservedAt === "string" &&
    Number.isFinite(Date.parse(upload.reservedAt)) &&
    typeof upload.size === "number" &&
    Number.isSafeInteger(upload.size) &&
    upload.size > 0 &&
    upload.size <= MAX_IMAGE_UPLOAD_BYTES
  );
}

function createImageReservations(uploads: ImageUploadReservation[]): ImageUploadReservations {
  return {
    version: IMAGE_RESERVATIONS_VERSION,
    uploads: sortImageReservations(uploads),
  };
}

function sortImageReservations(uploads: ImageUploadReservation[]): ImageUploadReservation[] {
  return uploads.sort((left, right) => left.id.localeCompare(right.id));
}

function imageUploadReservationsMatch(left: ImageUploadReservation, right: ImageUploadReservation): boolean {
  return (
    left.clientUploadId === right.clientUploadId &&
    left.contentType === right.contentType &&
    left.digest === right.digest &&
    left.id === right.id &&
    left.mode === right.mode &&
    left.name === right.name &&
    left.size === right.size
  );
}

function imageReservationsEqual(left: ImageUploadReservation[], right: ImageUploadReservation[]): boolean {
  const sortedLeft = sortImageReservations([...left]);
  const sortedRight = sortImageReservations([...right]);

  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every(
      (upload, index) =>
        imageUploadReservationsMatch(upload, sortedRight[index]) &&
        upload.reservedAt === sortedRight[index]?.reservedAt,
    )
  );
}

async function putImageReservations(
  env: Env,
  reservations: ImageUploadReservations,
  expectedEtag?: string,
): Promise<R2Object | null> {
  return env.STATE.put(IMAGE_RESERVATIONS_KEY, JSON.stringify(reservations), {
    onlyIf: expectedEtag ? { etagMatches: expectedEtag } : { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, no-store",
    },
  });
}

function isImageCatalog(value: unknown): value is ImageCatalog {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const catalog = value as Record<string, unknown>;
  return (
    catalog.version === IMAGE_CATALOG_VERSION &&
    typeof catalog.updatedAt === "string" &&
    Array.isArray(catalog.images) &&
    catalog.images.length <= MAX_READABLE_CATALOG_IMAGES &&
    catalog.images.every(isStoredImageRecord)
  );
}

function isStoredImageRecord(value: unknown): value is StoredImageRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const image = value as Record<string, unknown>;
  return (
    typeof image.id === "string" &&
    isValidImageId(image.id) &&
    typeof image.name === "string" &&
    image.name.length > 0 &&
    image.name.length <= 160 &&
    typeof image.size === "number" &&
    Number.isSafeInteger(image.size) &&
    image.size > 0 &&
    image.size <= MAX_STORED_IMAGE_BYTES &&
    typeof image.uploadedAt === "string" &&
    Number.isFinite(Date.parse(image.uploadedAt)) &&
    typeof image.contentType === "string" &&
    ALLOWED_TYPES.has(image.contentType)
  );
}

function createImageCatalog(images: StoredImageRecord[]): ImageCatalog {
  return {
    version: IMAGE_CATALOG_VERSION,
    updatedAt: new Date().toISOString(),
    images: sortImageRecords(images),
  };
}

async function putImageCatalog(
  env: Env,
  catalog: ImageCatalog,
  expectedEtag?: string,
): Promise<R2Object | null> {
  return env.STATE.put(IMAGE_CATALOG_KEY, JSON.stringify(catalog), {
    onlyIf: expectedEtag ? { etagMatches: expectedEtag } : { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, no-store",
    },
  });
}

function cacheCatalog(catalog: ImageCatalog, object: R2Object): CatalogSnapshot {
  cachedCatalog = {
    catalog,
    etag: object.etag,
    httpEtag: object.httpEtag,
    expiresAt: Date.now() + IMAGE_CATALOG_CACHE_MS,
  };
  return cachedCatalog;
}

function upsertImageRecords(current: StoredImageRecord[], additions: StoredImageRecord[]): StoredImageRecord[] {
  const byId = new Map(current.map((image) => [image.id, image]));

  for (const image of additions) {
    byId.set(image.id, image);
  }

  return sortImageRecords([...byId.values()]);
}

function sortImageRecords(images: StoredImageRecord[]): StoredImageRecord[] {
  return images.sort((left, right) => {
    const byDate = Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt);
    return byDate || left.id.localeCompare(right.id);
  });
}

function imageRecordsEqual(left: StoredImageRecord[], right: StoredImageRecord[]): boolean {
  return (
    left.length === right.length &&
    left.every((image, index) => {
      const other = right[index];
      return (
        image.id === other?.id &&
        image.name === other.name &&
        image.size === other.size &&
        image.uploadedAt === other.uploadedAt &&
        image.contentType === other.contentType
      );
    })
  );
}

function toStoredImageRecord(object: R2Object): StoredImageRecord {
  const image = toStoredImageRecordOrNull(object);

  if (!image) {
    throw new Error(`R2 object ${object.key} is not a valid gallery image.`);
  }

  return image;
}

function toStoredImageRecordOrNull(object: R2Object): StoredImageRecord | null {
  const id = object.key.slice(IMAGE_PREFIX.length);
  const metadata = object.customMetadata ?? {};
  const metadataContentType = object.httpMetadata?.contentType;
  const contentType = metadataContentType && ALLOWED_TYPES.has(metadataContentType) ? metadataContentType : contentTypeFromId(id);

  if (
    !isValidImageId(id) ||
    !ALLOWED_TYPES.has(contentType) ||
    !Number.isSafeInteger(object.size) ||
    object.size <= 0 ||
    object.size > MAX_STORED_IMAGE_BYTES
  ) {
    return null;
  }

  const uploadedAt = Number.isFinite(Date.parse(metadata.uploadedAt || ""))
    ? metadata.uploadedAt
    : object.uploaded.toISOString();
  const name = sanitizeUploadedFileName(metadata.name || readableNameFromId(id), contentType);

  return {
    id,
    name,
    size: object.size,
    uploadedAt,
    contentType,
  };
}

function toGalleryImage(image: StoredImageRecord, imageBaseUrl: URL): GalleryImage {
  return {
    ...image,
    url: new URL(encodeURIComponent(image.id), imageBaseUrl).toString(),
  };
}

function resolveImageBaseUrl(request: Request, env: Env): URL {
  const requestUrl = new URL(request.url);

  if (isLocalHostname(requestUrl.hostname)) {
    return new URL(`${API_ROUTES.images}/`, requestUrl);
  }

  const configured = env.PUBLIC_IMAGE_BASE_URL?.trim();

  if (configured) {
    try {
      const base = new URL(configured.endsWith("/") ? configured : `${configured}/`);

      if (base.protocol === "https:" || (base.protocol === "http:" && isLocalHostname(base.hostname))) {
        return new URL(IMAGE_PREFIX, base);
      }
    } catch {
      // Fall through to the same-origin API for invalid environment configuration.
    }
  }

  return new URL(`${API_ROUTES.images}/`, request.url);
}

function resolveConfiguredImageUrl(request: Request, env: Env, id: string): string | null {
  const requestUrl = new URL(request.url);

  if (isLocalHostname(requestUrl.hostname)) {
    return null;
  }

  const configured = env.PUBLIC_IMAGE_BASE_URL?.trim();

  if (!configured) {
    return null;
  }

  try {
    const base = new URL(configured.endsWith("/") ? configured : `${configured}/`);

    if (base.protocol !== "https:" && !(base.protocol === "http:" && isLocalHostname(base.hostname))) {
      return null;
    }

    return new URL(`${IMAGE_PREFIX}${encodeURIComponent(id)}`, base).toString();
  } catch {
    return null;
  }
}

function imageHttpMetadata(name: string, contentType: string): R2HTTPMetadata {
  return {
    cacheControl: IMAGE_CACHE_CONTROL,
    contentDisposition: `inline; filename="${name}"`,
    contentType,
  };
}

async function abortOrRememberMultipartUpload(
  env: Env,
  upload: R2MultipartUpload,
  state: MultipartUploadState,
): Promise<boolean> {
  try {
    await upload.abort();
    return false;
  } catch (abortError) {
    const orphanedState: MultipartUploadState = { ...state, orphaned: true };
    const recoveryKey = `${MULTIPART_UPLOAD_PREFIX}orphans/${crypto.randomUUID()}.json`;

    try {
      await env.STATE.put(recoveryKey, JSON.stringify(orphanedState), {
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
          cacheControl: "private, no-store",
        },
        customMetadata: {
          id: state.id,
          imageKey: state.key,
          uploadedAt: state.uploadedAt,
          uploadId: state.uploadId,
        },
      });
      return true;
    } catch (recoveryError) {
      console.error("Could not preserve failed multipart abort state", {
        abortError: safeErrorMessage(abortError),
        recoveryError: safeErrorMessage(recoveryError),
      });
      throw recoveryError;
    }
  }
}

async function cleanupStaleMultipartUploads(env: Env): Promise<MultipartCleanupResult> {
  const stateResult = await cleanupMultipartStatePage(env, env.STATE, STATE_CLEANUP_CURSOR_KEY);
  const legacyComplete = await env.STATE.head(LEGACY_CLEANUP_COMPLETE_KEY);
  const legacyResult = legacyComplete
    ? emptyCleanupResult()
    : await cleanupMultipartStatePage(env, env.IMAGES, LEGACY_CLEANUP_CURSOR_KEY, true);

  return mergeCleanupResults(stateResult, legacyResult);
}

async function cleanupMultipartStatePage(
  env: Env,
  stateBucket: R2Bucket,
  cursorKey: string,
  legacy = false,
): Promise<MultipartCleanupResult> {
  const result = emptyCleanupResult();
  const completedRecords: StoredImageRecord[] = [];
  const forceReservationIdsToRelease = new Set<string>();
  const reservationExpectationsToRelease: ImageReservationExpectation[] = [];
  const cursor = await readCleanupCursor(env, cursorKey);
  const options: R2ListWithMetadataOptions = {
    prefix: MULTIPART_UPLOAD_PREFIX,
    cursor,
    limit: MULTIPART_CLEANUP_PAGE_SIZE,
    include: ["customMetadata"],
  };
  let listed: R2Objects;

  try {
    listed = await stateBucket.list(options);
  } catch (error) {
    if (!cursor) {
      throw error;
    }

    await env.STATE.delete(cursorKey);
    listed = await stateBucket.list({ ...options, cursor: undefined });
  }

  const staleBeforeMs = Date.now() - STALE_MULTIPART_UPLOAD_MS;

  for (const object of listed.objects) {
    result.inspected += 1;
    const metadataUploadedAt = Date.parse(object.customMetadata?.uploadedAt || "");

    if (Number.isFinite(metadataUploadedAt) && metadataUploadedAt > staleBeforeMs) {
      result.skipped += 1;
      continue;
    }

    const stateSnapshot = await getMultipartStateFromBucket(stateBucket, object.key);
    const state = stateSnapshot?.state;
    const stateEtag = stateSnapshot?.etag ?? object.etag;

    if (state) {
      const uploadedAt = Date.parse(state.uploadedAt);

      if (Number.isFinite(uploadedAt) && uploadedAt > staleBeforeMs) {
        result.skipped += 1;
        continue;
      }

      const completed = await env.IMAGES.head(state.key);

      if (completed && !state.orphaned && matchesMultipartObject(completed, state)) {
        if (await isImageRetired(env, state.id)) {
          await env.IMAGES.delete(state.key);
          forceReservationIdsToRelease.add(state.id);
        } else {
          completedRecords.push(toStoredImageRecord(completed));
        }

        if (await claimAndDeleteMultipartStateObject(stateBucket, object.key, stateEtag)) {
          result.removed += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      try {
        await env.IMAGES.resumeMultipartUpload(state.key, state.uploadId).abort();
        result.aborted += 1;
      } catch {
        result.errors += 1;
        continue;
      }

      if (!completed || !matchesMultipartObject(completed, state)) {
        reservationExpectationsToRelease.push(multipartReservationExpectation(state));
      }
    } else {
      const uploadId = object.customMetadata?.uploadId;
      const imageKey = object.customMetadata?.imageKey;
      const id = object.customMetadata?.id;
      const uploadedAt = object.customMetadata?.uploadedAt;

      if (uploadId && imageKey?.startsWith(IMAGE_PREFIX)) {
        try {
          await env.IMAGES.resumeMultipartUpload(imageKey, uploadId).abort();
          result.aborted += 1;
        } catch {
          result.errors += 1;
          continue;
        }
      }

      if (
        id &&
        isValidImageId(id) &&
        uploadedAt &&
        Number.isFinite(Date.parse(uploadedAt))
      ) {
        reservationExpectationsToRelease.push({
          id,
          mode: "multipart",
          reservedAt: uploadedAt,
        });
      }
    }

    if (await claimAndDeleteMultipartStateObject(stateBucket, object.key, stateEtag)) {
      result.removed += 1;
    } else {
      result.skipped += 1;
    }
  }

  if (completedRecords.length > 0) {
    await mutateImageCatalog(env, (images) => upsertImageRecords(images, completedRecords));
    await rollbackRetiredImageRecords(env, completedRecords);
  }

  await releaseMatchingImageReservations(env, reservationExpectationsToRelease);
  await releaseImageReservations(env, [...forceReservationIdsToRelease]);

  if (listed.truncated) {
    result.pending = true;
    await env.STATE.put(cursorKey, listed.cursor, {
      httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: "private, no-store" },
    });
  } else {
    await env.STATE.delete(cursorKey);

    if (legacy && listed.objects.length === 0) {
      await env.STATE.put(LEGACY_CLEANUP_COMPLETE_KEY, new Date().toISOString(), {
        httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: "private, no-store" },
      });
    }
  }

  return result;
}

async function readCleanupCursor(env: Env, key: string): Promise<string | undefined> {
  const object = await env.STATE.get(key);

  if (!object || object.size > 2_048) {
    return undefined;
  }

  const cursor = (await object.text()).trim();
  return cursor || undefined;
}

async function writeMaintenanceCursor(env: Env, key: string, value?: string): Promise<void> {
  if (value === undefined) {
    await env.STATE.delete(key);
    return;
  }

  await env.STATE.put(key, value, {
    httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: "private, no-store" },
  });
}

function emptyCleanupResult(): MultipartCleanupResult {
  const staleBefore = new Date(Date.now() - STALE_MULTIPART_UPLOAD_MS).toISOString();
  return {
    aborted: 0,
    errors: 0,
    inspected: 0,
    pending: false,
    removed: 0,
    skipped: 0,
    staleAfterMs: STALE_MULTIPART_UPLOAD_MS,
    staleBefore,
  };
}

function mergeCleanupResults(left: MultipartCleanupResult, right: MultipartCleanupResult): MultipartCleanupResult {
  return {
    aborted: left.aborted + right.aborted,
    errors: left.errors + right.errors,
    inspected: left.inspected + right.inspected,
    pending: left.pending || right.pending,
    removed: left.removed + right.removed,
    skipped: left.skipped + right.skipped,
    staleAfterMs: STALE_MULTIPART_UPLOAD_MS,
    staleBefore: left.staleBefore,
  };
}

async function getMultipartState(env: Env, id: string): Promise<MultipartStateLocation | null> {
  const key = toMultipartStateKey(id);
  const snapshot = await getMultipartStateFromBucket(env.STATE, key);

  if (snapshot) {
    return { bucket: env.STATE, etag: snapshot.etag, key, state: snapshot.state };
  }

  const legacySnapshot = await getMultipartStateFromBucket(env.IMAGES, key);
  return legacySnapshot
    ? { bucket: env.IMAGES, etag: legacySnapshot.etag, key, state: legacySnapshot.state }
    : null;
}

async function getMultipartStateFromBucket(
  bucket: R2Bucket,
  key: string,
): Promise<MultipartStateSnapshot | null> {
  const object = await bucket.get(key);

  if (!object || object.size > MAX_MULTIPART_COMPLETE_BODY_BYTES) {
    return null;
  }

  try {
    const value = await object.json<unknown>();
    return isMultipartUploadState(value) ? { etag: object.etag, state: value } : null;
  } catch {
    return null;
  }
}

function isMultipartUploadState(value: unknown): value is MultipartUploadState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const state = value as Record<string, unknown>;
  return (
    (state.clientUploadId === undefined ||
      (typeof state.clientUploadId === "string" && CLIENT_UPLOAD_ID_PATTERN.test(state.clientUploadId))) &&
    typeof state.contentType === "string" &&
    ALLOWED_TYPES.has(state.contentType) &&
    typeof state.id === "string" &&
    isValidImageId(state.id) &&
    typeof state.key === "string" &&
    state.key === toStorageKey(state.id) &&
    typeof state.name === "string" &&
    state.name.length > 0 &&
    (state.orphaned === undefined || typeof state.orphaned === "boolean") &&
    typeof state.partSize === "number" &&
    Number.isSafeInteger(state.partSize) &&
    state.partSize >= DEFAULT_CHUNKED_UPLOAD_PART_BYTES &&
    typeof state.size === "number" &&
    Number.isSafeInteger(state.size) &&
    state.size > 0 &&
    state.size <= MAX_IMAGE_UPLOAD_BYTES &&
    typeof state.uploadedAt === "string" &&
    Number.isFinite(Date.parse(state.uploadedAt)) &&
    typeof state.uploadId === "string" &&
    state.uploadId.length > 0 &&
    state.uploadId.length <= 1_024
  );
}

async function removeMultipartState(location: MultipartStateLocation): Promise<boolean> {
  return claimAndDeleteMultipartStateObject(location.bucket, location.key, location.etag);
}

async function claimAndDeleteMultipartStateObject(
  bucket: R2Bucket,
  key: string,
  etag: string,
): Promise<boolean> {
  const claimed = await bucket.put(key, "", {
    onlyIf: { etagMatches: etag },
    httpMetadata: {
      contentType: "application/octet-stream",
      cacheControl: "private, no-store",
    },
  });

  if (!claimed) {
    return false;
  }

  await bucket.delete(key);
  return true;
}

function multipartStartMatches(
  state: MultipartUploadState,
  clientUploadId: string,
  name: string,
  size: number,
  contentType: string,
): boolean {
  return (
    state.clientUploadId === clientUploadId &&
    state.name === name &&
    state.size === size &&
    state.contentType === contentType
  );
}

function toMultipartStartResponse(
  state: MultipartUploadState,
  request: Request,
  env: Env,
): MultipartUploadStartResponse {
  return {
    ...toGalleryImage(
      {
        id: state.id,
        name: state.name,
        size: state.size,
        uploadedAt: state.uploadedAt,
        contentType: state.contentType,
      },
      resolveImageBaseUrl(request, env),
    ),
    partSize: state.partSize,
    uploadId: state.uploadId,
  };
}

function parseUploadedParts(value: unknown): R2UploadedPart[] {
  if (!Array.isArray(value) || value.length > Math.ceil(MAX_IMAGE_UPLOAD_BYTES / DEFAULT_CHUNKED_UPLOAD_PART_BYTES)) {
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
        !part.etag ||
        part.etag.length > 256
      ) {
        return null;
      }

      return { partNumber: part.partNumber, etag: part.etag };
    })
    .filter((part): part is R2UploadedPart => Boolean(part))
    .sort((left, right) => left.partNumber - right.partNumber);
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
  const base = escapeRegExp(API_ROUTES.multipartUploads);
  const uploadMatch = pathname.match(new RegExp(`^${base}/([^/]+)$`));

  if (uploadMatch?.[1]) {
    const id = decodePathSegment(uploadMatch[1]);

    if (!id) {
      throw new HttpError("Invalid upload id.", 400);
    }

    return { action: "upload", id };
  }

  const partMatch = pathname.match(new RegExp(`^${base}/([^/]+)/parts/(\\d+)$`));

  if (partMatch?.[1] && partMatch[2]) {
    const id = decodePathSegment(partMatch[1]);

    if (!id) {
      throw new HttpError("Invalid upload id.", 400);
    }

    return { action: "part", id, partNumber: Number(partMatch[2]) };
  }

  const completeMatch = pathname.match(new RegExp(`^${base}/([^/]+)/complete$`));

  if (completeMatch?.[1]) {
    const id = decodePathSegment(completeMatch[1]);

    if (!id) {
      throw new HttpError("Invalid upload id.", 400);
    }

    return { action: "complete", id };
  }

  return null;
}

function readClientUploadId(request: Request): string {
  const value = request.headers.get(API_HEADERS.uploadId)?.trim() || crypto.randomUUID();

  if (!CLIENT_UPLOAD_ID_PATTERN.test(value)) {
    throw new HttpError(`${API_HEADERS.uploadId} must be a UUID.`, 400);
  }

  return value.toLowerCase();
}

function matchesPreparedUpload(object: R2Object, upload: PreparedUpload): boolean {
  return (
    object.customMetadata?.uploadMode === "direct" &&
    object.customMetadata?.uploadKey === upload.uploadKey &&
    object.customMetadata?.name === upload.name &&
    object.customMetadata?.sha256 === upload.digest &&
    object.size === upload.size &&
    object.httpMetadata?.contentType === upload.contentType
  );
}

function matchesImageReservationObject(object: R2Object, reservation: ImageUploadReservation): boolean {
  const metadata = object.customMetadata;
  const commonMetadataMatches =
    metadata?.uploadMode === reservation.mode &&
    metadata.name === reservation.name &&
    object.size === reservation.size &&
    object.httpMetadata?.contentType === reservation.contentType;

  if (!commonMetadataMatches) {
    return false;
  }

  if (reservation.mode === "direct") {
    return (
      metadata.uploadKey === `${reservation.clientUploadId}:1` &&
      metadata.sha256 === reservation.digest
    );
  }

  return (
    metadata.clientUploadId === reservation.clientUploadId &&
    metadata.uploadKey === reservation.clientUploadId
  );
}

function matchesMultipartObject(object: R2Object, state: MultipartUploadState): boolean {
  const identityMatches = state.clientUploadId
    ? object.customMetadata?.uploadMode === "multipart" &&
      object.customMetadata?.clientUploadId === state.clientUploadId &&
      object.customMetadata?.uploadKey === state.clientUploadId
    : object.customMetadata?.uploadMode !== "direct";

  return (
    identityMatches &&
    object.customMetadata?.name === state.name &&
    object.size === state.size &&
    object.httpMetadata?.contentType === state.contentType
  );
}

function createImageId(fileName: string, contentType: string, token: string): string {
  const extension = extensionFromContentType(contentType);
  const stem = sanitizeIdStem(fileName.replace(/\.[^.]+$/, ""));
  return `${token}-${stem}${extension}`;
}

function extensionFromContentType(contentType: string): string {
  return EXTENSIONS_BY_TYPE.get(contentType) || ".img";
}

function contentTypeFromId(id: string): string {
  const extension = id.slice(id.lastIndexOf(".")).toLowerCase();

  for (const [contentType, candidate] of EXTENSIONS_BY_TYPE) {
    if (candidate === extension) {
      return contentType;
    }
  }

  return "application/octet-stream";
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
    .replace(/^[0-9a-f-]{36}(?:-\d+)?-/, "")
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

async function isImageRetired(env: Env, id: string): Promise<boolean> {
  return (await findRetiredImageIds(env, [id])).length > 0;
}

async function findRetiredImageIds(env: Env, ids: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids)];
  const markerObjects = await Promise.all(
    uniqueIds.map((id) => env.STATE.head(retiredImageMarkerKey(id))),
  );
  const idsByShard = new Map<number, string[]>();
  const retiredIds = new Set<string>();
  const activeAfter = Date.now() - RETIRED_IMAGE_TTL_MS;

  for (let index = 0; index < uniqueIds.length; index += 1) {
    const marker = markerObjects[index];

    if (marker && isRetiredImageMarkerActive(marker, activeAfter)) {
      retiredIds.add(uniqueIds[index]);
    }
  }

  for (const id of uniqueIds) {
    if (retiredIds.has(id)) {
      continue;
    }

    const shard = legacyRetiredImageShardIndex(id);
    idsByShard.set(shard, [...(idsByShard.get(shard) ?? []), id]);
  }

  for (const [shard, shardIds] of idsByShard) {
    const retired = await readLegacyRetiredImageShard(env, shard);
    const activeIds = new Set(
      retired.images
        .filter((image) => Date.parse(image.retiredAt) > activeAfter)
        .map((image) => image.id),
    );

    for (const id of shardIds) {
      if (activeIds.has(id)) {
        retiredIds.add(id);
      }
    }
  }

  return uniqueIds.filter((id) => retiredIds.has(id));
}

async function requireImageIdsAvailable(env: Env, ids: string[]): Promise<void> {
  if ((await findRetiredImageIds(env, ids)).length > 0) {
    throw new HttpError("This image id has been retired and cannot be reused.", 410);
  }
}

async function removeRetiredImage(env: Env, id: string): Promise<boolean> {
  if (!(await isImageRetired(env, id))) {
    return false;
  }

  await env.IMAGES.delete(toStorageKey(id));
  await mutateImageCatalog(env, (images) => images.filter((image) => image.id !== id));
  await releaseImageReservations(env, [id]);
  return true;
}

async function rollbackRetiredImageRecords(
  env: Env,
  records: StoredImageRecord[],
): Promise<string[]> {
  const retiredIds = await findRetiredImageIds(
    env,
    records.map((record) => record.id),
  );

  if (retiredIds.length === 0) {
    return [];
  }

  const retiredIdSet = new Set(retiredIds);
  await env.IMAGES.delete(retiredIds.map(toStorageKey));

  try {
    await mutateImageCatalog(env, (images) => images.filter((image) => !retiredIdSet.has(image.id)));
  } finally {
    await releaseImageReservations(env, retiredIds);
  }

  return retiredIds;
}

async function requireMultipartStateActive(location: MultipartStateLocation, env: Env): Promise<void> {
  if (!(await isImageRetired(env, location.state.id))) {
    return;
  }

  await abortMultipartState(location, env);
  throw new HttpError("This image id has been retired.", 410);
}

async function abortMultipartState(location: MultipartStateLocation, env: Env): Promise<void> {
  const completed = await env.IMAGES.head(location.state.key);

  if (completed) {
    await env.IMAGES.delete(location.state.key);
    await mutateImageCatalog(env, (images) => images.filter((image) => image.id !== location.state.id));
    await removeMultipartState(location);
    await releaseImageReservations(env, [location.state.id]);
    return;
  }

  try {
    await env.IMAGES.resumeMultipartUpload(location.state.key, location.state.uploadId).abort();
  } catch {
    const racedCompletion = await env.IMAGES.head(location.state.key);

    if (!racedCompletion) {
      throw new HttpError("The retired multipart upload could not be aborted. Try again later.", 503);
    }

    await env.IMAGES.delete(location.state.key);
    await mutateImageCatalog(env, (images) => images.filter((image) => image.id !== location.state.id));
  }

  await removeMultipartState(location);
  await releaseImageReservations(env, [location.state.id]);
}

async function retireImageIds(env: Env, ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  await Promise.all(uniqueIds.map((id) => retireImageId(env, id)));
}

async function retireImageId(env: Env, id: string): Promise<void> {
  const key = retiredImageMarkerKey(id);
  const retiredAt = new Date().toISOString();
  const activeAfter = Date.now() - RETIRED_IMAGE_TTL_MS;

  for (let attempt = 0; attempt < CATALOG_MUTATION_ATTEMPTS; attempt += 1) {
    const object = await env.STATE.head(key);

    if (object && isRetiredImageMarkerActive(object, activeAfter)) {
      return;
    }

    const stored = await env.STATE.put(key, JSON.stringify({ id, retiredAt }), {
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "private, no-store",
      },
      customMetadata: { id, retiredAt },
    });

    if (stored) {
      return;
    }

    await shortRetryDelay(attempt);
  }

  throw new Error(`Concurrent retirement updates did not converge for image ${id}.`);
}

async function pruneLegacyRetiredImageShardPage(env: Env): Promise<void> {
  const interval = Math.floor(Date.now() / (60 * 60 * 1000));
  await pruneLegacyRetiredImageShard(env, interval % LEGACY_RETIRED_IMAGE_SHARD_COUNT);
}

async function pruneLegacyRetiredImageShard(env: Env, shard: number): Promise<void> {
  const key = legacyRetiredImageShardKey(shard);
  const activeAfter = Date.now() - RETIRED_IMAGE_TTL_MS;

  for (let attempt = 0; attempt < CATALOG_MUTATION_ATTEMPTS; attempt += 1) {
    const object = await env.STATE.get(key);

    if (!object) {
      return;
    }

    const current = await parseRetiredImagesObject(object);

    if (!current) {
      throw new Error(`Legacy retired image shard ${shard} is invalid.`);
    }

    const next = createRetiredImages(
      current.images.filter((image) => Date.parse(image.retiredAt) > activeAfter),
    );

    if (retiredImagesEqual(current.images, next.images)) {
      return;
    }

    const stored = await putRetiredImages(env, key, next, object?.etag);

    if (stored) {
      return;
    }

    await shortRetryDelay(attempt);
  }

  throw new Error(`Legacy retired image shard pruning did not converge for shard ${shard}.`);
}

function retiredImagesEqual(left: RetiredImageRecord[], right: RetiredImageRecord[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (image, index) =>
        image.id === right[index]?.id && image.retiredAt === right[index]?.retiredAt,
    )
  );
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
    Number.isSafeInteger(value.size) &&
    typeof value.type === "string" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.stream === "function" &&
    value.size > 0
  );
}

async function requireMutationAccess(request: Request, env: Env): Promise<void> {
  requireTrustedOrigin(request);

  if (!(await isAuthenticated(request, env))) {
    throw new HttpError("Sign in before changing images.", 401);
  }

  const result = await env.MUTATION_RATE_LIMITER.limit({ key: "mutation:uploader" });

  if (!result.success) {
    throw new HttpError("Too many mutation requests. Try again later.", 429, { "retry-after": "60" });
  }
}

async function requirePublicApiCapacity(request: Request, env: Env): Promise<void> {
  const actor = request.headers.get("cf-connecting-ip") || "unknown";
  const result = await env.PUBLIC_API_RATE_LIMITER.limit({ key: `public-api:${actor}` });

  if (!result.success) {
    throw new HttpError("Too many API requests. Try again later.", 429, { "retry-after": "60" });
  }
}

function requireTrustedOrigin(request: Request): void {
  if (!isTrustedOrigin(request)) {
    throw new HttpError("Cross-origin mutation requests are not allowed.", 403);
  }
}

function isTrustedOrigin(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");

  if (origin && origin !== requestOrigin) {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");

  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }

  if (!origin) {
    const referer = request.headers.get("referer");

    if (referer) {
      try {
        return new URL(referer).origin === requestOrigin;
      } catch {
        return false;
      }
    }
  }

  return true;
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
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      v: 1,
      sub: "uploader",
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    }),
  );
  return `${payload}.${await sign(payload, env.AUTH_SECRET || "")}`;
}

async function verifySessionToken(token: string, env: Env): Promise<boolean> {
  if (token.length > MAX_SESSION_TOKEN_LENGTH) {
    return false;
  }

  const parts = token.split(".");

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return false;
  }

  const [payload, signature] = parts;
  const expectedSignature = await sign(payload, env.AUTH_SECRET || "");

  if (!constantTimeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const session = JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    return (
      session.v === 1 &&
      session.sub === "uploader" &&
      typeof session.iat === "number" &&
      Number.isInteger(session.iat) &&
      session.iat <= now + 60 &&
      typeof session.exp === "number" &&
      Number.isInteger(session.exp) &&
      session.exp > now &&
      session.exp - session.iat === SESSION_TTL_SECONDS
    );
  } catch {
    return false;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  if (!cachedAuthKey || cachedAuthKey.secret !== secret) {
    cachedAuthKey = {
      secret,
      key: await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    };
  }

  const signature = await crypto.subtle.sign("HMAC", cachedAuthKey.key, new TextEncoder().encode(value));
  return base64UrlEncode(signature);
}

function serializeSessionCookie(value: string, request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Priority=High${secure}`;
}

function getCookie(cookieHeader: string, name: string): string | null {
  const prefix = `${name}=`;
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  if (!cookie) {
    return null;
  }

  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return null;
  }
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

async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T | null> {
  const bytes = await readRequestBytes(request, maxBytes);

  if (bytes.byteLength === 0) {
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

async function readRequestBytes(request: Request, maxBytes: number, exactBytes?: number): Promise<Uint8Array> {
  const contentLength = parseContentLength(request.headers.get("content-length"));

  if (contentLength !== null && contentLength > maxBytes) {
    throw new HttpError("Request body is too large.", 413);
  }

  if (exactBytes !== undefined && contentLength !== null && contentLength !== exactBytes) {
    throw new HttpError("Upload part size does not match the declared file size.", 400);
  }

  if (!request.body) {
    if (exactBytes) {
      throw new HttpError("Upload part is empty.", 400);
    }

    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError("Request body is too large.", 413);
    }

    chunks.push(value);
  }

  if (exactBytes !== undefined && total !== exactBytes) {
    throw new HttpError("Upload part size does not match the declared file size.", 400);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function requireContentType(request: Request, expected: string): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";

  if (contentType !== expected) {
    throw new HttpError(`Content-Type must be ${expected}.`, 415);
  }
}

function requestBodyTooLarge(request: Request, maxBytes: number): boolean {
  const contentLength = parseContentLength(request.headers.get("content-length"));
  return contentLength !== null && contentLength > maxBytes;
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

function canonicalApiPath(pathname: string): { legacy: boolean; pathname: string } {
  if (pathname === API_BASE_PATH || pathname.startsWith(`${API_BASE_PATH}/`)) {
    return { legacy: false, pathname };
  }

  if (pathname === LEGACY_API_BASE_PATH || pathname.startsWith(`${LEGACY_API_BASE_PATH}/`)) {
    return {
      legacy: true,
      pathname: `${API_BASE_PATH}${pathname.slice(LEGACY_API_BASE_PATH.length)}`,
    };
  }

  return { legacy: false, pathname };
}

function withLegacyApiHeaders(response: Response, request: Request, pathname: string): Response {
  const headers = new Headers(response.headers);
  const successor = new URL(request.url);
  successor.pathname = pathname;
  headers.set("deprecation", "true");
  headers.append("link", `<${successor.toString()}>; rel="successor-version"`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function methodNotAllowed(methods: string[]): Response {
  return json({ error: "Method not allowed" }, 405, { allow: methods.join(", ") });
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-api-version": "1",
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
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": `content-type,${API_HEADERS.uploadId}`,
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function etagMatches(header: string | null, etag: string): boolean {
  return Boolean(header?.split(",").some((value) => value.trim() === etag || value.trim() === "*"));
}

function catalogResponseEtag(catalogEtag: string, imageBaseUrl: URL): string {
  let hash = 2166136261;

  for (const character of imageBaseUrl.toString()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return `W/"${catalogEtag}-${(hash >>> 0).toString(16)}"`;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
}

function shortRetryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt + Math.random() * 10));
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers?: HeadersInit,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
