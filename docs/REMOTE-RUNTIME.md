# Web app on Docker

This stack is a **browser web app**, not a macOS app. You open a URL. Bots keep
running in Compose after you close the tab.

The reconstructed Electron app (`npm run package`) stays in the repository as
the Mac desktop product. Do not add an “Install on local Docker” control to that
app, and do not make Electron a client of this stack.

OpenRouter is the only inference provider. Put the stack on a tailnet (or
another private network). There is no site access token.

## Architecture

```text
Browser ── HTTPS ── Dokploy Traefik ── control:8080
                                        ├ static UI + /health + /debug + /ws
                                        ├ node-agent-coordinator (fork-ipc)
                                        └ OpenRouter
control ── HTTP ── box:1340 (sand-host gateway)
control ── HTTP/WS ── box:6080/6081 (noVNC, same-origin `/__grok_bot/vnc/…`)
```

`control` binds `0.0.0.0` and serves HTTP and WebSocket on one port so a single
domain is enough. Traefik is the public proxy. There is no Caddy service.
`SAND_GATEWAY_TOKEN` still authenticates control to the box gateway. Do not
expose box:1340.

## Dokploy

1. Service type **Docker Compose**.
2. Compose path `deploy/docker-compose.yml`.
3. Environment (Dokploy writes a `.env` file; Compose interpolates `${VAR}`):
   - `OPENROUTER_API_KEY`
   - `SAND_GATEWAY_TOKEN` (shared by control and the box gateway)
   - `PUBLIC_URL=https://<your-domain>`
   - `COMPOSE_PARALLEL_LIMIT=1` (Compose process, not a container env)
   - optional `COMPOSIO_API_KEY` for Connect plugins
   - optional `RUNTIME_DEBUG=1` for the corner overlay and verbose debug
4. Compose builds `control` and `box` from `deploy/Dockerfile` targets that
   share one Node `build` stage. `COMPOSE_PARALLEL_LIMIT=1` keeps those
   builds sequential so the second image reuses the cache instead of racing
   a second `npm ci`.
5. **Disable Isolated Deployments** on a 4GB (or similar) host. Leaving the
   old `sand-box` stack up while the new one builds will swap the machine.
   Expect a short restart on each deploy. Do not add Traefik labels or
   `dokploy-network` to the Compose file; Dokploy injects those.
6. Domain → service `control`, port `8080`, HTTPS. Keep the service off the
   public internet unless the tailnet (or equivalent) is the only path in.
7. Grok’s screen is proxied through control at `/__grok_bot/vnc/primary` (box:6080)
   and `/__grok_bot/vnc/fork` (box:6081). A separate VNC domain is optional.
8. Volume backups for `box-workspace`, `box-data`, and `control-data`.

The base Compose file uses named volumes only (a Dokploy `git clone` would wipe
repo bind-mounts). Internal ports are `expose`d, not published on the host.
Control and box images are `linux/amd64` for the box; the Dokploy host should be
x86_64.

Name, email, and Gravatar are saved in control settings. Open **Settings →
Router → You** to change them.

## Local Compose (no Dokploy)

```sh
export OPENROUTER_API_KEY=...
export SAND_GATEWAY_TOKEN=...
export PUBLIC_URL=http://127.0.0.1:8080
export COMPOSE_PARALLEL_LIMIT=1
docker compose --project-directory . -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up --build
```

Open `http://127.0.0.1:8080`. The local overlay publishes only
`127.0.0.1:8080:8080` on `control` and turns `RUNTIME_DEBUG` on.

Verify in this order before treating the UI as healthy:

1. `GET /health` → `ok: true`, `runtime: "docker"`, box reachable.
2. Open `/debug`. Confirm coordinator alive and WS ready.
3. Open `/`. Confirm the overlay (`data-testid="grok-bot-debug-overlay"`) or
   `window.__grokBotDebug.connection === "connected"`.
4. Open `/`. Confirm the shipped Grok Bot UI (sidebar + chat), not the
   fallback banner “Shipped renderer is not in this image.”

The control image stages `deploy/control/shipped-renderer` during `docker
build`. That directory is the checksum-pinned 0.18 renderer so Linux/Dokploy
builds serve the real UI instead of the debug shell.

## Debug surface

Logs and RPC traces redact tokens, API keys, and cookies to the last four
characters.

- `GET /health` — JSON for probes. Stable fields: `ok`, `runtime: "docker"`,
  control pid/uptime, coordinator child alive + last exit, box gateway probe,
  OpenRouter configured (boolean only), WS listener ready.
- `GET /debug` — owned HTML (not the shipped renderer) with `data-testid` on
  every status row, the last ~200 log lines, last ~100 RPC calls, stubbed
  Electron methods, WS client counts, and one-click “probe box /health” plus
  “send ping RPC”.
- Overlay on `/` when `RUNTIME_DEBUG=1`: WS connected / reconnecting / down and
  the last RPC error. `window.__grokBotDebug` exposes `health()`, `rpcLog`, and
  `connection` for DevTools.

Do not mount `docker.sock` into `control`. Box-side `box-doctor` remains a
command inside the box; the debug page probes the gateway `/health` instead.

## Honest limits

- OpenRouter only.
- No Mac filesystem tools, WebAuthn, Cursor login, or window chrome.
- The shipped UI still looks like a desktop shell; Electron RPCs are stubbed
  rather than restyling the whole frontend.
- Closing a browser tab does not stop the containers.

## Leftover macOS package

`npm run package` still builds the reconstructed Mac app with its in-process
coordinator, Router, local profile, and local Docker VM. That path is
independent of this Compose stack.
