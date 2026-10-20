FROM node:24.21.0-alpine AS base
RUN npm install -g pnpm@12.12.1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/ops/package.json apps/ops/
COPY packages/logging/package.json packages/logging/
COPY packages/ebay/package.json packages/ebay/
COPY packages/db/package.json packages/db/

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter "@ebay-sniper/server..." --filter "@ebay-sniper/ops..."

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@ebay-sniper/server..." --filter "@ebay-sniper/ops..."
COPY packages/logging packages/logging
COPY packages/ebay packages/ebay
COPY packages/db packages/db
COPY apps/server apps/server
COPY apps/ops apps/ops
RUN pnpm --filter "@ebay-sniper/server..." --filter "@ebay-sniper/ops..." build

# One image for the server and the migrate one-off (apps/ops), tagged ebay-sniper-server:<sha>.
FROM node:24.21.0-alpine
ARG GIT_SHA
RUN test -n "$GIT_SHA" || { echo "GIT_SHA build arg is required" >&2; exit 1; }
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /repo ./
COPY --from=build --chown=node:node /repo/packages/logging/dist ./packages/logging/dist
COPY --from=build --chown=node:node /repo/packages/ebay/dist ./packages/ebay/dist
COPY --from=build --chown=node:node /repo/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /repo/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /repo/apps/ops/dist ./apps/ops/dist
USER node
WORKDIR /app/apps/server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
