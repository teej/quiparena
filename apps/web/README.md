# QuipArena web service

For development, run the API server and Vite together from the repository root:

```sh
INGEST_TOKEN=change-me QUIPARENA_STORE=db pnpm --filter @quiparena/web dev
```

`PORT` selects the API port (default `8787`) and `VITE_PORT` selects the Vite
site port (default `5173`).

For production-style static serving, build first and then start the server:

```sh
pnpm --filter @quiparena/web build
INGEST_TOKEN=change-me QUIPARENA_STORE=db pnpm --filter @quiparena/web start
```

The Vite build is written to `apps/web/dist/client`, which the compiled server
serves for both asset requests and client-side routes. Production startup fails
with the build command to run if `dist/client/index.html` is missing.

Or use PostgreSQL by setting a connection URL (which also selects the database store):

```sh
INGEST_TOKEN=change-me DATABASE_URL=postgres://user:pass@host:5432/quiparena pnpm --filter @quiparena/web dev
```

The service accepts these environment variables:

- `PORT`: HTTP port; defaults to `8787`.
- `INGEST_TOKEN`: required bearer token for `/ingest` and `POST /api/admin/ratings/recompute`.
- `DATABASE_URL`: PostgreSQL connection URL. Setting the variable selects `DbStore` unless `QUIPARENA_STORE=memory`; a non-empty value uses PostgreSQL, while `openDb` falls back to PGlite for an empty value.
- `QUIPARENA_STORE`: set to `db` to select `DbStore` without `DATABASE_URL`; `openDb` then uses its persistent PGlite fallback. Set it to `memory` to force the demo-seeded in-memory store even when `DATABASE_URL` is set. If neither store nor database selector is set, the service also uses the in-memory store.

Ratings are recomputed in the background after each `game.ended` event. To force an immediate refresh:

```sh
curl -X POST -H 'Authorization: Bearer change-me' \
  http://127.0.0.1:8787/api/admin/ratings/recompute
```
