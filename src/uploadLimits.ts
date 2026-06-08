export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 8;
export const MAX_UPLOAD_TOTAL_BYTES = MAX_UPLOAD_BYTES * MAX_UPLOAD_FILES;
export const MAX_UPLOAD_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_TOTAL_BYTES + MAX_UPLOAD_MULTIPART_OVERHEAD_BYTES;
export const MAX_UPLOAD_SIZE_LABEL = "10 MB";
export const MAX_UPLOAD_TOTAL_SIZE_LABEL = "80 MB";

export const ACCEPTED_IMAGE_TYPES = [
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
