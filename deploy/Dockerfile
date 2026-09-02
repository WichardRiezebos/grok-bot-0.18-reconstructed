# syntax=docker/dockerfile:1
FROM node:26.5-bookworm-slim AS build
WORKDIR /src
ENV NODE_OPTIONS=--max-old-space-size=1536 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    GROK_BOT_REQUIRE_RENDERER=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts && \
    npm install --no-save esbuild@0.28.2
COPY scripts/ scripts/
COPY source/ source/
COPY deploy/control/shipped-renderer/ deploy/control/shipped-renderer/
RUN node scripts/apply-third-party-patches.mjs && node scripts/build-web-runtime.mjs

FROM node:26.5-bookworm-slim AS control
WORKDIR /app
ENV NODE_ENV=production \
    GROK_BOT_LISTEN_HOST=0.0.0.0 \
    GROK_BOT_LISTEN_PORT=8080 \
    GROK_BOT_DATA_DIR=/var/lib/grok-bot \
    GROK_BOT_COORDINATOR_ARTIFACT=/app/node-agent-coordinator/main.cjs \
    GROK_BOT_STATIC_ROOT=/app/static \
    GROK_BOT_RENDERER_ROOT=/app/renderer
COPY --from=build /src/.build/web-runtime/server-main.cjs /app/server-main.cjs
COPY --from=build /src/.build/web-runtime/node-agent-coordinator /app/node-agent-coordinator
COPY --from=build /src/.build/web-runtime/static /app/static
COPY --from=build /src/.build/web-runtime/web-shim.js /app/web-shim.js
COPY --from=build /src/.build/web-runtime/overlay.js /app/overlay.js
COPY --from=build /src/.build/web-runtime/renderer /app/renderer
COPY --from=build /src/scripts/debug-coordinator-fork.cjs /app/scripts/debug-coordinator-fork.cjs
EXPOSE 8080
CMD ["node", "/app/server-main.cjs"]

FROM public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest AS box
COPY --from=build /src/.build/web-runtime/host/host-main.cjs /home/box/sand-host/host-main.cjs
COPY --from=build /src/.build/web-runtime/host/agent-isolation /home/box/sand-host/agent-isolation
COPY --from=build /src/.build/web-runtime/host/extensions /home/box/sand-host/extensions
COPY --from=build /src/.build/web-runtime/box-exec-daemon /home/box/box-exec-daemon
ENV SAND_SUPERVISOR_ENABLED=1 \
    SAND_BOX_AUTO_UPDATE=0 \
    SAND_USE_EXISTING_BOX_EXEC_DAEMON=1 \
    SAND_GATEWAY_BIND_HOST=0.0.0.0 \
    SAND_HOST_PORT=1340 \
    SAND_TREE_SITTER_NODE_DEPS=/home/box/deps \
    NODE_PATH=/home/box/deps
