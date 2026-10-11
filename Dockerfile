# syntax=docker/dockerfile:1
# Credoc web: the built landing + dashboard and the gasless relayer, served by one small Node server.
#   docker build -t credoc:local .        (context = repo root: the web app depends on ../sdk)

# ---- build: dependencies, typecheck, Vite build, server bundle. Never reaches the runtime image.
FROM node:22.20-alpine3.22@sha256:dbcedd8aeab47fbc0f4dd4bffa55b7c3c729a707875968d467aaaea42d6225af AS build
WORKDIR /src
# manifests first: dependency layers only rebuild when a lockfile changes
COPY sdk/package.json sdk/package-lock.json sdk/
COPY web/package.json web/package-lock.json web/.npmrc web/
# --ignore-scripts: no install-time code from the dependency tree runs in the build (npm worm class)
WORKDIR /src/sdk
RUN npm ci --ignore-scripts --no-audit --no-fund
WORKDIR /src/web
RUN npm ci --ignore-scripts --no-audit --no-fund
WORKDIR /src
COPY sdk/ sdk/
COPY web/ web/
# public, build-time configuration only (baked into the client bundle); secrets are runtime env, never build args
ARG VITE_CREDOC_ADDRESS=""
ARG VITE_CREDOC_FROM_BLOCK="0"
ARG VITE_RPC_URL=""
WORKDIR /src/web
RUN npm run build && npm run build:server

# ---- runtime: distroless Node, no shell, no package manager, non-root
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
WORKDIR /app
COPY --from=build /src/web/dist ./dist
COPY --from=build /src/web/dist-server/server.mjs ./server.mjs
ENV NODE_ENV=production STATIC_DIR=/app/dist PORT=8080
USER 65532:65532
EXPOSE 8080
LABEL org.opencontainers.image.title="credoc-web" \
      org.opencontainers.image.description="Credoc: letters of credit settled on Arc" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["/app/server.mjs"]
