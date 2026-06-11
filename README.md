# Neuro Gallery

A Cloudflare Worker image API with a React frontend. Users upload their own images, the Worker stores them in R2, and `/random` redirects to one image from the uploaded pool.

## Features

- React + Vite frontend for image upload, preview, gallery management, and random selection.
- Cloudflare Worker API for uploads, listing, deletion, object serving, and random redirects.
- R2-backed storage so uploaded images persist across Worker instances.
- Public image URLs use the R2 custom domain `https://images.evilneur.org/`.
- Signed upload sessions so only authenticated users can upload or delete images.
- `/api/random?format=json` returns metadata; `/random` redirects directly to the selected image.

## API

| Route | Method | Description |
| --- | --- | --- |
| `/api/auth/session` | `GET` | Check whether the uploader session is authenticated. |
| `/api/auth/login` | `POST` | Sign in using `{ "password": "..." }`; sets an HTTP-only session cookie. |
| `/api/auth/logout` | `POST` | Clear the uploader session cookie. |
| `/api/images` | `GET` | List uploaded images. |
| `/api/images` | `POST` | Authenticated. Upload one or more image files using `multipart/form-data` field `images`. |
| `/api/images/:id` | `GET` | Serve an uploaded image. |
| `/api/images/:id` | `DELETE` | Authenticated. Remove an uploaded image. |
| `/api/uploads/multipart` | `POST` | Authenticated. Start a chunked R2 multipart upload for large images. |
| `/api/uploads/multipart/:id/parts/:partNumber` | `PUT` | Authenticated. Upload one binary chunk for a multipart upload. |
| `/api/uploads/multipart/:id/complete` | `POST` | Authenticated. Complete a multipart upload. |
| `/api/random?format=json` | `GET` | Return a random image record. |
| `/random` | `GET` | Redirect to a random uploaded image. |

## Authentication

Uploads and deletes require two secrets:

- `UPLOAD_PASSWORD`: the password entered in the frontend; use at least 12 characters.
- `AUTH_SECRET`: a long random string used to sign the HTTP-only session cookie; use at least 32 characters.

For local development:

```sh
cp .dev.vars.example .dev.vars
```

Then edit `.dev.vars`.

Uploads accept PNG, JPEG, WebP, AVIF, and GIF files. Large frontend uploads are split into R2 multipart chunks so they do not depend on one oversized request body. SVG uploads are intentionally rejected because same-origin SVG content can execute active scripts. Uploaded filenames are cleaned automatically before storage.

## Local development

Install dependencies:

```sh
npm install
```

Run the frontend-only Vite server:

```sh
npm run dev
```

Run the Worker with built frontend assets and local R2 storage:

```sh
npm run dev:worker
```

## Manual Deploy

For local or manual deploys, create the R2 bucket named in `wrangler.toml`:

```sh
npx wrangler r2 bucket create neuro-gallery-images
```

Create the production secrets:

```sh
npx wrangler secret put UPLOAD_PASSWORD
npx wrangler secret put AUTH_SECRET
```

Then deploy:

```sh
npm run deploy
```

## GitHub Deploys

The workflow in `.github/workflows/deploy.yml` deploys on pushes to `main` and can also be run manually from GitHub Actions. On first run, it creates the configured R2 buckets if they do not exist, writes the Worker runtime secrets from GitHub secrets into a temporary file, and deploys with Wrangler.

Add these repository secrets in GitHub:

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID for the Worker.
- `CLOUDFLARE_API_TOKEN`: an API token that can deploy Workers and create/read R2 buckets.
- `UPLOAD_PASSWORD`: the production upload password.
- `AUTH_SECRET`: the production session signing secret.

For local or manual deploys, create the Worker runtime secrets with Wrangler:

```sh
npx wrangler secret put UPLOAD_PASSWORD
npx wrangler secret put AUTH_SECRET
```

To use a different bucket name, update `bucket_name` in `wrangler.toml`.
