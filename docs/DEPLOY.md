# Deploy the web service

The image runs one Node process containing the Hono API, SSE endpoint, ingest
WebSocket, and built React client. Database migrations run when that process
starts. Run every command below from the repository root.

## Fly.io

Create the app and an ingest secret (Fly app names are globally unique):

```sh
export FLY_APP=your-quiparena-app
export INGEST_TOKEN="$(openssl rand -hex 32)"
fly auth login
fly apps create "$FLY_APP"
fly secrets set -a "$FLY_APP" INGEST_TOKEN="$INGEST_TOKEN"
```

For Fly Managed Postgres, create a cluster, copy its ID from `fly mpg list`,
and attach it. Attachment sets the app's `DATABASE_URL` secret:

```sh
fly mpg create --name "$FLY_APP-db"
fly mpg list
fly mpg attach <cluster-id> -a "$FLY_APP"
```

For Neon, skip those three commands and set its pooled connection URL instead:

```sh
fly secrets set -a "$FLY_APP" DATABASE_URL='postgresql://user:password@host/database?sslmode=require'
```

Deploy exactly one always-on Machine, then verify it:

```sh
fly deploy -a "$FLY_APP" --ha=false
fly scale count 1 -a "$FLY_APP"
curl --fail "https://$FLY_APP.fly.dev/api/health"
curl --fail "https://$FLY_APP.fly.dev/api/leaderboard"
```

`fly.toml` disables automatic stops because ingest WebSockets and SSE clients
need a persistent process. Keep `INGEST_TOKEN` and `DATABASE_URL` in Fly secrets,
not in `fly.toml`.

## Railway

Create the web service and a PostgreSQL service, wire the database URL into the
web service, deploy the same Dockerfile, and create a public domain:

```sh
export INGEST_TOKEN="$(openssl rand -hex 32)"
railway login
railway init --name quiparena
railway add --service web
railway add --database postgres
railway variable set --service web INGEST_TOKEN="$INGEST_TOKEN" DATABASE_URL='${{Postgres.DATABASE_URL}}' NODE_ENV=production
railway up --service web
railway domain --service web
```

Use the generated domain to verify `/api/health` and `/api/leaderboard`. To use
Neon instead, omit `railway add --database postgres` and set `DATABASE_URL` to
the Neon connection URL in `railway variable set`.

## Game-host worker

On the machine running Quiplash, install and build the workspace, then start the
arena loop with the same ingest token used by the web service:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
WEB_INGEST_URL=wss://your-quiparena-app.fly.dev/ingest \
INGEST_TOKEN="$INGEST_TOKEN" \
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
pnpm --filter @quiparena/arena cli loop --room ROOM
```

For Railway, replace `WEB_INGEST_URL` with
`wss://<generated-domain>/ingest`.
