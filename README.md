# Neuro Gallery

A Cloudflare Worker image API with a React frontend. Users upload their own images, the Worker stores them in R2, and `/random` redirects to one image from the uploaded pool.

## Features

- React + Vite frontend for image upload, preview, gallery management, and random selection.
- Cloudflare Worker API for uploads, listing, deletion, object serving, and random redirects.
- R2-backed image storage plus a separate private R2 state bucket for the catalog and multipart sessions.
- Public image URLs use the configurable R2 custom domain `https://images.evilneur.org/` without proxying image bytes through the Worker.
- Signed upload sessions so only authenticated users can upload or delete images.
- A versioned `/api/v1` contract shared by the Worker and frontend. Legacy `/api/*` aliases remain available with a `Deprecation` response header.
- `/api/v1/random?format=json` returns metadata; `/random` redirects directly to the selected image.
- A conditionally updated R2 catalog replaces full bucket scans on list and random requests. Hourly paged reconciliation repairs drift without scanning the full bucket in one Worker invocation.

## API

| Route | Method | Description |
| --- | --- | --- |
| `/api/v1/auth/session` | `GET` | Check whether the uploader session is authenticated. |
| `/api/v1/auth/login` | `POST` | Sign in using `{ "password": "..." }`; sets an HTTP-only session cookie. |
| `/api/v1/auth/logout` | `POST` | Clear the uploader session cookie. |
| `/api/v1/images` | `GET` | List uploaded images. Responses use an R2 catalog ETag and a short browser cache. |
| `/api/v1/images` | `POST` | Authenticated. Upload one image up to 4 MiB using the `images` form field. |
| `/api/v1/images/:id` | `GET` | Serve an uploaded image when no public media origin is configured. |
| `/api/v1/images/:id` | `DELETE` | Authenticated. Remove an uploaded image. |
| `/api/v1/uploads/multipart` | `POST` | Authenticated. Start or resume an idempotent chunked upload. |
| `/api/v1/uploads/multipart/:id/parts/:partNumber` | `PUT` | Authenticated. Upload one size-checked binary chunk. |
| `/api/v1/uploads/multipart/:id/complete` | `POST` | Authenticated. Complete or recover a multipart upload. |
| `/api/v1/random?format=json` | `GET` | Return a random image record. |
| `/random` | `GET` | Redirect to a random uploaded image. |

The frontend sends a UUID in `x-upload-id`, making retried direct uploads and multipart starts idempotent. API clients should do the same. Direct-upload retries are bound to a SHA-256 digest, and deleted IDs remain retired for 370 days so an immutable public URL cannot serve different bytes while an old cache entry is valid. The frontend sends selected files as independent direct requests and splits bulk deletes into 16-ID requests. Image records contain a `url` on the media origin; the media origin is intentionally separate from the metadata/control API to avoid extra Worker invocations.

## Authentication

Uploads and deletes require two secrets:

- `UPLOAD_PASSWORD`: the password entered in the frontend; use at least 12 characters.
- `AUTH_SECRET`: a long random string used to sign the HTTP-only session cookie; use at least 32 characters.

For local development:

```sh
cp .dev.vars.example .dev.vars
```

Then edit `.dev.vars`.

Uploads accept PNG, JPEG, WebP, AVIF, and GIF files up to 100 MiB. Files over 4 MiB use streamed R2 multipart uploads with 8 MiB chunks, limited parallelism, and exact-size checks. SVG uploads are intentionally rejected because active image content should not share the application origin. Uploaded filenames are cleaned automatically before storage.

Login attempts are protected by the `LOGIN_RATE_LIMITER` Worker binding, authenticated mutations have a separate 120-requests-per-minute limiter, and public metadata/session routes use a 300-requests-per-minute-per-client limiter. Their numeric namespaces in `wrangler.toml` must remain unique within the Cloudflare account. Mutation routes also require a signed, HTTP-only, same-site session cookie and a same-origin browser request. A conditionally updated reservation registry limits the gallery to 2,000 images and 9 decimal GB of committed plus pending image data, with at most 512 MiB pending and 50 active multipart sessions. This leaves headroom below R2's 10 GB-month free allowance for state and cleanup lag. Hourly bounded reconciliation, scheduled cleanup, and the R2 lifecycle rule handle abandoned state and parts.

## Operational Limits

The 2,000-image limit and eight-record reconciliation pages are a pragmatic Workers Free profile, not a hard CPU guarantee. Catalogs created before this limit remain readable and deletable up to 50,000 records so they can be drained, but uploads stay blocked while the active gallery exceeds 2,000 images or 9 GB. Use Workers Paid while draining a larger catalog and monitor Cloudflare for `exceededCpu` events; the Free plan allows only 10 ms of CPU per HTTP or Cron invocation.

Deleted IDs use individual, conditionally written state objects for 370 days, so retirement capacity cannot block deletion. The Worker still reads and prunes the earlier 16-shard format for migration compatibility but never writes new IDs to it. Configure the `STATE` bucket to expire objects under `catalog/retired-images-v2/` after 371 days or later. Do not expire them earlier unless the corresponding custom-domain URLs have been purged and cannot be rebound from an old immutable cache entry.

## Local development

Use Node.js 22.12 or newer.

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

For local or manual deploys, create both R2 buckets named in `wrangler.toml`:

```sh
npx wrangler r2 bucket create neuro-gallery-images
npx wrangler r2 bucket create neuro-gallery-state
```

Attach the domain in `PUBLIC_IMAGE_BASE_URL` as a public custom domain on the `IMAGES` bucket before enabling it in production. Do not expose the `STATE` bucket through a custom domain or `r2.dev`. Configure R2 lifecycle rules that abort incomplete multipart uploads and expire `STATE` objects under `catalog/retired-images-v2/` after at least 371 days. These rules backstop Worker cleanup without shortening the immutable-URL retirement window.

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

The workflow in `.github/workflows/deploy.yml` deploys on pushes to `main` and can also be run manually from GitHub Actions. On first run, it creates the image and private state R2 buckets if they do not exist, writes the Worker runtime secrets to a mode-`0600` temporary file, and deploys with Wrangler. Custom-domain attachment and R2 lifecycle rules remain explicit Cloudflare account setup steps.

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

To use different bucket names, update both `bucket_name` values in `wrangler.toml` and the two bucket-name variables in `.github/workflows/deploy.yml`. Set `PUBLIC_IMAGE_BASE_URL` to the root of the public R2 custom domain. The Worker falls back to same-origin `/api/v1/images/:id` URLs when this variable is absent or invalid, which keeps local and staging environments functional.

Uploaded objects use long-lived immutable cache headers because an ID cannot be reused during the cache lifetime. Deleting an R2 object removes it from the API catalog immediately, but an already cached public copy can remain at the custom domain until its edge cache is purged. Purge that URL in Cloudflare when immediate public revocation is required.
