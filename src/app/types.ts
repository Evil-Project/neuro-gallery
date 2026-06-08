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

export interface RandomResponse {
  image: GalleryImage;
}

export interface AuthSessionResponse {
  authenticated: boolean;
}
