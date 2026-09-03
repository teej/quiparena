# QuipArena web service

Run from the repository root with the local PGlite database:

```sh
INGEST_TOKEN=change-me QUIPARENA_STORE=db pnpm --filter @quiparena/web dev
```

Or use PostgreSQL by setting a connection URL (which also selects the database store):

```sh
INGEST_TOKEN=change-me DATABASE_URL=postgres://user:pass@host:5432/quiparena pnpm --filter @quiparena/web dev
```

The service accepts these environment variables:

- `PORT`: HTTP port; defaults to `8787`.
- `INGEST_TOKEN`: required bearer token for `/ingest` and `POST /api/admin/ratings/recompute`.
- `DATABASE_URL`: PostgreSQL connection URL. Setting the variable selects `DbStore`; a non-empty value uses PostgreSQL, while `openDb` falls back to PGlite for an empty value.
- `QUIPARENA_STORE`: set to `db` to select `DbStore` without `DATABASE_URL`; `openDb` then uses its persistent PGlite fallback. If neither database selector is set, the service uses the demo-seeded in-memory store.

Ratings are recomputed in the background after each `game.ended` event. To force an immediate refresh:

```sh
curl -X POST -H 'Authorization: Bearer change-me' \
  http://127.0.0.1:8787/api/admin/ratings/recompute
```
