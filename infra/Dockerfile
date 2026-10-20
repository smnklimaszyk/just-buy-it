FROM node:24.21.0-alpine AS base
RUN npm install -g pnpm@12.12.1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/logging/package.json packages/logging/

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter "@ebay-sniper/server..."

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@ebay-sniper/server..."
COPY packages/logging packages/logging
COPY apps/server apps/server
RUN pnpm --filter "@ebay-sniper/server..." build

FROM node:24.21.0-alpine
ARG GIT_SHA
RUN test -n "$GIT_SHA" || { echo "GIT_SHA build arg is required" >&2; exit 1; }
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /repo ./
COPY --from=build --chown=node:node /repo/packages/logging/dist ./packages/logging/dist
COPY --from=build --chown=node:node /repo/apps/server/dist ./apps/server/dist
USER node
WORKDIR /app/apps/server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
