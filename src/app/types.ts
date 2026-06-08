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
}

export interface MultipartUploadStartResponse {
  id: string;
  uploadId: string;
  partSize: number;
  name: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  url: string;
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

export interface RandomResponse {
  image: GalleryImage;
}

export interface AuthSessionResponse {
  authenticated: boolean;
}
