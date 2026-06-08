export const ACCEPTED_IMAGE_TYPES = [
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const DEFAULT_CHUNKED_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const MAX_MULTIPART_UPLOAD_PARTS = 10_000;

export function selectChunkedUploadPartSize(fileSize: number): number {
  return Math.max(DEFAULT_CHUNKED_UPLOAD_PART_BYTES, Math.ceil(fileSize / MAX_MULTIPART_UPLOAD_PARTS));
}
