# Keep BUN_VERSION equal to .bun-version (CI checks), so tests and production
# run on the same runtime.
ARG BUN_VERSION=1.4.2
ARG NODE_VERSION=24

# Dependencies are installed with `npm ci` from package-lock.json, the same
# lockfile and installer CI tests with, so the image runs the tested tree.

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Production dependencies only, in their own stage so they are cached until
# the lockfile changes.
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM tailscale/tailscale:v1.102.5 AS tailscale

FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./
COPY server server
# data/ is the volume for usage.db; a bind-mounted host directory must be
# writable by uid 1000 (bun).
RUN mkdir -p data && chown bun:bun data
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "server/src/healthcheck.ts"]
CMD ["bun", "server/src/index.ts"]
