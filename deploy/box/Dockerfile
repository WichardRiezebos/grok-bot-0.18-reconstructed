FROM node:26.5-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/apply-third-party-patches.mjs && node scripts/build-web-runtime.mjs

FROM public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest
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
