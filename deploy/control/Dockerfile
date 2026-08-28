FROM node:26.5-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
ENV GROK_BOT_REQUIRE_RENDERER=1
RUN node scripts/apply-third-party-patches.mjs && node scripts/build-web-runtime.mjs

FROM node:26.5-bookworm-slim
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
EXPOSE 8080
CMD ["node", "/app/server-main.cjs"]
