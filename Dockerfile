FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm build
RUN pnpm --filter @quiparena/web --prod deploy /app

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
WORKDIR /app

COPY --from=build --chown=node:node /app ./

USER node
EXPOSE 8080

CMD ["node", "dist/server/index.js"]
