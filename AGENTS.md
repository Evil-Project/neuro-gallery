# Repository Guidelines

## Project Structure & Module Organization

This repository is a Cloudflare Worker app with a React/Vite frontend.

- `src/worker.ts`: Worker API for auth, image upload, R2 object serving, deletion, and random redirects.
- `src/main.tsx`: React entrypoint.
- `src/app/`: frontend application code, API client, shared types, and styling.
- `public/`: static public assets, currently the favicon.
- `dist/`: generated production frontend assets; do not edit directly.
- `wrangler.toml`: Cloudflare Worker, Static Assets, and R2 binding configuration.

There is no dedicated `tests/` directory yet.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: run the frontend-only Vite dev server at `127.0.0.1`.
- `npm run build`: typecheck both app and Worker, then build production assets into `dist/`.
- `npm run dev:worker`: build assets and run the full Worker locally at `http://localhost:8787`.
- `npm run preview`: preview the built frontend with Vite.
- `npm run typecheck`: run TypeScript project checks without building Vite assets.
- `npm run deploy`: build and deploy with Wrangler.

## Coding Style & Naming Conventions

Use TypeScript and ES modules. Keep React components in PascalCase, helper functions in camelCase, and API response/type interfaces in PascalCase. Prefer small, explicit functions over broad abstractions.

Keep indentation at two spaces. CSS classes use lowercase kebab-case-like names already present in `src/app/styles.css`. Do not edit generated `dist/` output.

## Testing Guidelines

No automated test framework is configured yet. For now, verify changes with:

```sh
npm run typecheck
npm run build
npm audit --omit=optional
```

For Worker behavior, use `npm run dev:worker` and exercise endpoints with `curl`, especially auth-gated `POST /api/images` and `DELETE /api/images/:id`.

## Commit & Pull Request Guidelines

Git history currently contains only an initial non-standard commit message (`Add files via upload`), so no established convention exists. Use Conventional Commits going forward, for example `feat: require authentication for uploads` or `fix: handle empty image pool`.

Pull requests should include a short change summary, verification commands run, screenshots for UI changes, and any required Cloudflare configuration notes.

## Security & Configuration Tips

Uploads and deletes require `UPLOAD_PASSWORD` and `AUTH_SECRET`. Use `.dev.vars` for local secrets and `wrangler secret put` for production. Never commit `.dev.vars`, real passwords, or session secrets.
