FROM node:24.22.0-alpine AS base
RUN npm install -g pnpm@12.12.1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/ops/package.json apps/ops/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/logging/package.json packages/logging/
COPY packages/ebay/package.json packages/ebay/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/llm/package.json packages/llm/
COPY packages/notify/package.json packages/notify/

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter "@ebay-sniper/server..." --filter "@ebay-sniper/ops..." \
  --filter "@ebay-sniper/worker..." --filter "@ebay-sniper/web..."

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@ebay-sniper/server..." --filter "@ebay-sniper/ops..." \
  --filter "@ebay-sniper/worker..." --filter "@ebay-sniper/web..."
COPY packages/logging packages/logging
COPY packages/ebay packages/ebay
COPY packages/db packages/db
COPY packages/domain packages/domain
# Only what the build needs: the offline eval set (packages/llm/evals) stays out of the image.
COPY packages/llm/tsconfig.json packages/llm/tsconfig.build.json packages/llm/
COPY packages/llm/src packages/llm/src
COPY packages/notify packages/notify
COPY apps/server apps/server
COPY apps/ops apps/ops
COPY apps/worker apps/worker
# With design-system/ (tokens, component CSS, fonts, icon paths) that the asset build reads.
COPY apps/web apps/web
RUN pnpm --filter "@ebay-sniper/server..." --filter "@ebay-sniper/ops..." --filter "@ebay-sniper/worker..." \
  --filter "@ebay-sniper/web..." build

# One image for the server, the worker, the web service and the migrate one-off (apps/ops), tagged
# ebay-sniper-server:<sha>. Compose picks the app with working_dir and command.
FROM node:24.22.0-alpine
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
COPY --from=build --chown=node:node /repo/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /repo/packages/llm/dist ./packages/llm/dist
COPY --from=build --chown=node:node /repo/packages/notify/dist ./packages/notify/dist
COPY --from=build --chown=node:node /repo/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /repo/apps/ops/dist ./apps/ops/dist
COPY --from=build --chown=node:node /repo/apps/worker/dist ./apps/worker/dist
# dist/assets holds the hashed styles, fonts and page scripts; dist/ui reads the icon paths from
# design-system/icons.json at run time, and the fonts' OFL notice ships with them.
COPY --from=build --chown=node:node /repo/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /repo/apps/web/design-system ./apps/web/design-system
USER node
WORKDIR /app/apps/server
EXPOSE 3000
# The server's check; the worker service in Compose replaces it with its heartbeat check.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
