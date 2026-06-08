# Neuro Gallery

A Cloudflare Worker image API with a React frontend. Users upload their own images, the Worker stores them in R2, and `/random` redirects to one image from the uploaded pool.

## Features

- React + Vite frontend for image upload, preview, gallery management, and random selection.
- Cloudflare Worker API for uploads, listing, deletion, object serving, and random redirects.
- R2-backed storage so uploaded images persist across Worker instances.
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
| `/api/random?format=json` | `GET` | Return a random image record. |
| `/random` | `GET` | Redirect to a random uploaded image. |

## Authentication

Uploads and deletes require two secrets:

- `UPLOAD_PASSWORD`: the password entered in the frontend.
- `AUTH_SECRET`: a long random string used to sign the HTTP-only session cookie.

For local development:

```sh
cp .dev.vars.example .dev.vars
```

Then edit `.dev.vars`.

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

## Deploy

Create the R2 buckets named in `wrangler.toml`:

```sh
npx wrangler r2 bucket create neuro-gallery-images
npx wrangler r2 bucket create neuro-gallery-images-dev
```

Create the production secrets:

```sh
npx wrangler secret put UPLOAD_PASSWORD
npx wrangler secret put AUTH_SECRET
```

Deploy:

```sh
npm run deploy
```

To use different bucket names, update `bucket_name` and `preview_bucket_name` in `wrangler.toml`.
