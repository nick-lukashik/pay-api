# syntax=docker/dockerfile:1
#   docker build --build-arg APP_VERSION=$(git rev-parse HEAD) -t nest-example .
#   docker run --rm -p 4000:3000 -p 9464:9464 --env-file .env -e PORT=3000 nest-example
# APP_VERSION is the only build arg: one image runs on stage and prod, the rest
# is runtime env. Migrations run from the same image before a rollout:
# node dist/db/migrate.js (Argo CD Sync-hook Job, wave 0, before the Deployment).

# base: the Node image every stage starts from. Renovate updates the tag.
FROM node:26.13.0-trixie-slim AS base
WORKDIR /app

# deps: pnpm and the manifests.
FROM base AS deps
ENV CI=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Node 25+ ships without corepack: install the pnpm that package.json "packageManager" names.
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
    && npm cache clean --force

# build: dist/ from src/.
FROM deps AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# prod-deps: node_modules without dev dependencies.
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# runtime: files stay owned by root, so the app cannot change itself. The
# numeric non-root user (Kubernetes can verify runAsNonRoot) writes nothing:
# it runs with a read-only root filesystem, only /tmp writable (emptyDir).
FROM base AS runtime
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="nest-example" \
      org.opencontainers.image.version="${APP_VERSION}"
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=3000 \
    METRICS_PORT=9464
COPY package.json ./
COPY drizzle ./drizzle
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 10001:10001
EXPOSE 3000 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
