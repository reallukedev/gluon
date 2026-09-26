# syntax=docker/dockerfile:1.7
# ---- deps: full toolchain so native modules (better-sqlite3, argon2) build or fetch prebuilds
FROM node:24-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --foreground-scripts

# ---- build
FROM node:24-bookworm AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# public/ can arrive missing (git, and so an app store, drops empty folders); the runtime copies it.
RUN mkdir -p public && npm run build

# ---- runtime: slim image + the host tools Gluon drives
FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      util-linux smartmontools iproute2 procps unzip 7zip xz-utils bzip2 zstd tar libarchive-tools \
      dnsutils iputils-ping ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8130 HOSTNAME=0.0.0.0 GLUON_DATA=/data
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Entry point: stamps the real TCP peer on each request (see the file), then runs server.js.
COPY docker/gluon-server.cjs ./gluon-server.cjs
# The self-updater Gluon hands to the host (Settings → Updates); see the file.
COPY docker/gluon-update.sh ./gluon-update.sh
# What this build is, for Settings → Updates: the release version, the commit it was built from,
# and a build label (a store version, or "github" for builds the updater made).
ARG GLUON_VERSION=""
ARG GLUON_COMMIT=""
ARG GLUON_BUILD=""
ENV GLUON_VERSION=$GLUON_VERSION GLUON_COMMIT=$GLUON_COMMIT GLUON_BUILD=$GLUON_BUILD
# Tells net-zone that every request carries the peer stamp; a request without one is treated as
# "away" (fails closed if server.js is ever started without the wrapper).
ENV GLUON_PEER_HEADER=1
EXPOSE 8130
# pid: host means tini is not PID 1, so it registers as a subreaper to still collect zombies.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "gluon-server.cjs"]
