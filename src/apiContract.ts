export const API_BASE_PATH = "/api/v1";
export const LEGACY_API_BASE_PATH = "/api";
export const PUBLIC_RANDOM_PATH = "/random";
export const API_HEADERS = {
  uploadId: "x-upload-id",
} as const;

export const API_ROUTES = {
  authSession: `${API_BASE_PATH}/auth/session`,
  authLogin: `${API_BASE_PATH}/auth/login`,
  authLogout: `${API_BASE_PATH}/auth/logout`,
  images: `${API_BASE_PATH}/images`,
  image: (id: string) => `${API_BASE_PATH}/images/${encodeURIComponent(id)}`,
  multipartUploads: `${API_BASE_PATH}/uploads/multipart`,
  multipartUpload: (id: string) => `${API_BASE_PATH}/uploads/multipart/${encodeURIComponent(id)}`,
  multipartPart: (id: string, partNumber: number) =>
    `${API_BASE_PATH}/uploads/multipart/${encodeURIComponent(id)}/parts/${partNumber}`,
  multipartComplete: (id: string) => `${API_BASE_PATH}/uploads/multipart/${encodeURIComponent(id)}/complete`,
  multipartCleanup: `${API_BASE_PATH}/uploads/multipart/cleanup`,
  random: `${API_BASE_PATH}/random`,
} as const;

export interface GalleryImage {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  contentType: string;
  url: string;
}

export interface ImagesResponse {
  count: number;
  images: GalleryImage[];
}

export interface UploadResponse {
  count: number;
  uploaded: GalleryImage[];
}

export interface DeleteImagesResponse {
  count: number;
  deleted: string[];
  ok: boolean;
}

export interface MultipartUploadStartResponse extends GalleryImage {
  partSize: number;
  uploadId: string;
}

export interface MultipartUploadPartResponse {
  part: {
    partNumber: number;
    etag: string;
  };
}

export interface MultipartUploadCompleteResponse {
  image: GalleryImage;
}

export interface MultipartUploadCleanupResponse {
  aborted: number;
  errors: number;
  inspected: number;
  removed: number;
  skipped: number;
  staleAfterMs: number;
  staleBefore: string;
  pending?: boolean;
}

export interface RandomResponse {
  image: GalleryImage;
}

export interface AuthSessionResponse {
  authenticated: boolean;
}
