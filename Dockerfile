# syntax=docker/dockerfile:1
#
# Taskora container images (multi-stage). Two final targets:
#
#   api  - Fastify API (node dist/server.js). The same image runs the
#          background worker with: node dist/worker.js
#   web  - nginx serving the React SPA and reverse-proxying /api/ to `api`
#
#   docker build --target api -t taskora-api .
#   docker build --target web -t taskora-web .
#
# Normally built through docker-compose.yml (`docker compose up -d --build`).
#
# The root devDependency `embedded-postgres` (local development only) is never
# installed: build stages install the workspaces only
# (--include-workspace-root=false) and the runtime image installs only the
# API's production dependencies.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:stable-alpine

# --------------------------------------------------------------------------
# Build dependencies: all workspace dependencies (incl. dev), no root devDeps.
# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build-deps
WORKDIR /src
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Install scripts are disabled (npm 10 ignores the `allowScripts` block in
# package.json); esbuild is the only build tool whose postinstall we want.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspaces --include-workspace-root=false --ignore-scripts \
 && npm rebuild esbuild
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/

# --------------------------------------------------------------------------
# API bundle (esbuild) -> apps/api/dist
# --------------------------------------------------------------------------
FROM build-deps AS build-api
COPY apps/api/ apps/api/
RUN npm run build -w @taskora/api \
 && test -f apps/api/dist/server.js \
 && test -f apps/api/dist/worker.js \
 && test -f apps/api/dist/db/migrate-cli.js \
 && test -f apps/api/dist/cli/reset-password.js

# --------------------------------------------------------------------------
# SPA bundle (Vite) -> apps/web/dist, plus the nginx security headers with the
# CSP hashes of the inline scripts in the built index.html.
# --------------------------------------------------------------------------
FROM build-deps AS build-web
COPY apps/web/ apps/web/
RUN npm run build -w @taskora/web && test -f apps/web/dist/index.html
COPY deploy/nginx/ /deploy/nginx/
RUN node /deploy/nginx/inject-csp-hashes.mjs \
      apps/web/dist/index.html \
      /deploy/nginx/security-headers.conf.in \
      /deploy/nginx/security-headers.conf

# --------------------------------------------------------------------------
# API production dependencies only (no dev deps, no web deps, no root deps).
# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api-deps
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# No production dependency needs an install script (@node-rs/argon2 ships
# prebuilt binaries as optional platform packages).
# Afterwards drop what the bundle never loads at runtime: PGlite (tests only,
# kept by npm as an optional peer of drizzle-orm), type declarations and the
# workspace links (@taskora/shared is bundled into dist/), plus the empty scope
# folders npm 10 leaves for omitted dev packages (e.g. node_modules/@vitest).
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --workspace=@taskora/api --include-workspace-root=false \
 && rm -rf node_modules/@electric-sql node_modules/@types node_modules/@taskora \
 && find node_modules -mindepth 1 -maxdepth 1 -type d -empty -delete \
 && mkdir -p apps/api/node_modules

# --------------------------------------------------------------------------
# Target: api (also used for the worker)
# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
ARG TASKORA_VERSION=dev
LABEL org.opencontainers.image.title="taskora-api" \
      org.opencontainers.image.description="Taskora PSA - API server and background worker" \
      org.opencontainers.image.version="${TASKORA_VERSION}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    UPLOAD_DIR=/app/data/uploads \
    BACKUP_DIR=/app/data/backups \
    NODE_OPTIONS=--enable-source-maps \
    TASKORA_VERSION=${TASKORA_VERSION}

WORKDIR /app/apps/api

# Application files are owned by root and read-only for the runtime user;
# only /app/data (uploads and backups volumes) is writable.
COPY --from=api-deps /app/node_modules /app/node_modules
COPY --from=api-deps /app/apps/api/node_modules ./node_modules
# package.json provides "type": "module" for the ESM bundle in dist/.
COPY apps/api/package.json ./package.json
# dist/ and drizzle/ are siblings: migrationsFolder() resolves ../drizzle from
# dist/ and ../../drizzle from dist/db/.
COPY apps/api/drizzle ./drizzle
COPY --from=build-api /src/apps/api/dist ./dist
COPY --chmod=0755 deploy/docker-entrypoint.sh /usr/local/bin/taskora-entrypoint

RUN mkdir -p /app/data/uploads /app/data/backups \
 && chown -R node:node /app/data \
 && chmod 0750 /app/data /app/data/uploads /app/data/backups

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini (PID 1) forwards signals and reaps zombies; the entrypoint drops empty
# optional settings before exec'ing the command.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/taskora-entrypoint"]
CMD ["node", "dist/server.js"]

# --------------------------------------------------------------------------
# Target: web (nginx, unprivileged, port 8080)
# --------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS web
ARG TASKORA_VERSION=dev
LABEL org.opencontainers.image.title="taskora-web" \
      org.opencontainers.image.description="Taskora PSA - web UI (nginx serving the SPA and proxying /api/)" \
      org.opencontainers.image.version="${TASKORA_VERSION}"

# Runtime settings rendered into conf.d/taskora.conf by the image entrypoint.
# The filter restricts envsubst to these variables only.
ENV NGINX_CLIENT_MAX_BODY_SIZE=30m \
    NGINX_RESTORE_MAX_BODY_SIZE=1024m \
    NGINX_REAL_IP_FROM=127.0.0.1/32 \
    NGINX_API_UPSTREAM=api:3000 \
    NGINX_ENVSUBST_FILTER="^NGINX_(CLIENT_MAX_BODY_SIZE|RESTORE_MAX_BODY_SIZE|REAL_IP_FROM|API_UPSTREAM)$"

RUN rm -f /etc/nginx/conf.d/default.conf \
 && rm -rf /usr/share/nginx/html/* \
 && mkdir -p /etc/nginx/templates /etc/nginx/snippets \
 && chown -R nginx:nginx /var/cache/nginx /etc/nginx/conf.d

COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/taskora.conf.template /etc/nginx/templates/taskora.conf.template
COPY --from=build-web /deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build-web /src/apps/web/dist/ /usr/share/nginx/html/

USER nginx

# Validate the configuration at build time (as the runtime user, with the
# default settings), then remove the rendered file and nginx temp dirs again.
RUN envsubst "$(printf '${%s} ' NGINX_CLIENT_MAX_BODY_SIZE NGINX_RESTORE_MAX_BODY_SIZE NGINX_REAL_IP_FROM NGINX_API_UPSTREAM)" \
      < /etc/nginx/templates/taskora.conf.template > /etc/nginx/conf.d/taskora.conf \
 && nginx -t \
 && rm -rf /etc/nginx/conf.d/taskora.conf /tmp/*_temp /tmp/nginx.pid

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/nginx-health || exit 1

# ENTRYPOINT/CMD are inherited from the nginx image (its entrypoint renders
# /etc/nginx/templates/*.template before starting nginx).
