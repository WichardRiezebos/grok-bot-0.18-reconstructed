# Grok Bot 0.18 — reconstructed and extended

![Grok Bot Router settings with OpenRouter, profile, and local usage totals](docs/assets/router-settings.png)

This repository is an unofficial, source-oriented reconstruction of the
publicly shipped Grok Bot 0.18.0 macOS app.

The project began as an attempt to understand how the desktop app was put
together. It now contains readable TypeScript implementations of its Electron,
host, coordinator, local-execution, protocol, and renderer boundaries, plus a
deterministic toolchain for turning those sources back into a working macOS
application.

It also adds a few practical experiments:

- OpenRouter as the only inference path, with chat vs computer models;
- Composio Connect plugins from a saved API key;
- a local name, email, and Gravatar on the account menu;
- local usage and OpenRouter spend in Settings;
- a local Docker sandbox for computer use; and
- a reconstructed settings surface integrated into the polished shipped UI.

This is a hacking and research project, not Anysphere's original monorepo and
not an official Grok Bot release. Names and module boundaries inferred from a
compiled application may differ from the original source.

## What is in the repository?

The checked-in tree contains the reviewed reconstruction, tests, manifests,
build scripts, and Git LFS preservation copies of the original macOS arm64 and
Windows x64 installers. It deliberately does **not** commit the extracted
upstream application, build output, local credentials, or the large forensic
recovery workspace.

The public Grok Bot 0.18.0 application is instead treated as a pinned build
input. During bootstrap, the toolchain downloads it, verifies its SHA-256
identity, and extracts the pieces required to assemble the reconstruction.

The resulting app is a hybrid by design:

- application runtimes are compiled from the readable sources under `source/`;
- the polished shipped renderer remains the UI baseline;
- a narrow deterministic transform adds the reconstructed Router settings UI;
- original and patched renderer chunk hashes are recorded and verified; and
- the finished app uses a separate bundle identifier and an ad-hoc signature.

The upstream app installed on the machine is never overwritten.

The desktop reconstruction stays pinned to the 0.18.0 release. The
**web/Dokploy app** ships the pinned 0.36.0 shipped frontend instead
(`deploy/control/shipped-renderer`, staged via `npm run web:bootstrap` and
extended by the same deterministic Router/settings transform, re-derived for
the 0.36.0 chunks).

### Why retain the shipped renderer?

The distributed application did not include the original frontend source or
source maps. It contained optimized, minified production JavaScript and CSS
chunks: enough to inspect behavior and recover contracts, but not the authored
React components, names, comments, file structure, or design-system source.

Recreating the complete frontend with the same polish and behavior would have
been a separate, much larger reverse-engineering project. It was not a realistic
goal for a weekend build. The practical choice was therefore to reconstruct the
runtime and control-plane code, retain the checksum-pinned shipped renderer,
and make the smallest auditable UI patch needed for the new Router settings.

`frontend/` is a readable partial reconstruction and design workspace. It is
useful for understanding UI contracts and experimenting with clean components,
but it should not be mistaken for Anysphere's missing original frontend source
or a pixel-perfect replacement for the packaged renderer.

## Preserved original installers

Research copies of the exact 0.18.0 installers live under
`research-archives/original/0.18.0/` and are stored with Git LFS:

| Platform | File | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `macos-arm64/Grok_Bot_0.18.0.dmg` | `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb` |
| Windows x64 | `windows-x64/Grok_Bot_0.18.0_Setup.exe` | `464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e` |

See [research-archives/README.md](research-archives/README.md) for source URLs,
sizes, verification commands, and the machine-readable artifact manifest.

## Current features

### Inference Router

Open **Settings → Router** to configure this local Grok Bot:

- your **name** and **email**, with a live Gravatar preview in the sidebar;
- the OpenRouter API key plus chat and computer models;
- a Composio API key for Connect plugins;
- the local Docker computer status; and
- recorded OpenRouter spend, requests, and tokens.

There is no Cursor login and no Claude Code or Codex route. The official Grok
Bot product remains Cursor's.

**Usage & Billing** shows locally recorded OpenRouter activity, including
`usage.cost` when the provider returns it. These figures are activity records,
not an authoritative invoice. The account menu usage row opens
[OpenRouter activity](https://openrouter.ai/activity).

### Local Docker sandbox

Computer use always runs in a local Docker VM (`grok-bot-local-vm`). Settings
show whether that container is running. **Update Computer** pulls
`sand-box-latest` and recreates the container while keeping workspace and data
volumes.

A Docker-compatible engine (OrbStack, Docker Desktop, Colima, or Rancher Desktop)
must be running.

### Web app on Docker (Dokploy)

The same reconstruction can also run as a **browser web app** on a Compose
stack (`control` + `box`). You open a URL. Bots keep running after you close
the tab. OpenRouter is the only provider in that stack. The web app renders
the pinned Grok Bot **0.36.0** shipped frontend with the reconstructed Router
settings (Settings → Router) and composio Gmail routines integrated.
Because there is no cloud backend, scheduled routines fire locally on a
30-second due-run loop (`source/host/extensions/automations/local-due-run-scheduler.ts`),
so cron routines run with the tab closed, exactly like the shipped product's
cloud-scheduled runs.

See [docs/REMOTE-RUNTIME.md](docs/REMOTE-RUNTIME.md) for Dokploy steps, the
local Compose overlay on `http://127.0.0.1:8080`, and the `/health` plus
`/debug` verification surface. Behavioral parity with the shipped Grok Bot
product is audited against the official design essay in
[docs/DESIGN-PARITY.md](docs/DESIGN-PARITY.md).

## Requirements

- macOS on Apple Silicon
- Node.js 26.5.x
- Xcode Command Line Tools
- Git LFS
- a Docker-compatible engine (OrbStack, Docker Desktop, Colima, …) for computer use
- an OpenRouter API key

## Quick start

```sh
git clone <your-repository-url>
cd grok-bot-0.18-reconstructed
git lfs install
git lfs pull
npm ci
npm run bootstrap
npm run check
npm run package
open "dist/Grok Bot 0.18 Reconstructed.app"
```

`npm run bootstrap` first uses the Git LFS preservation copy of the pinned
0.18.0 DMG. If that archive is absent, it falls back to the original public URL;
`GROK_BOT_018_APP` can also point to an existing application copy. Bootstrap
verifies both the DMG and `app.asar`, caches the matching Electron runtime, and
hydrates the ignored `src/app/dist` build input.

`npm run package` compiles the reconstructed runtimes, applies the narrow
renderer/settings transform, creates the app bundle, assigns the reconstructed
bundle identity, ad-hoc signs it, and verifies the result. Output is written to:

```text
dist/Grok Bot 0.18 Reconstructed.app
```

Reconstructed packages disable the upstream updater at the packaging boundary
and default upstream Sentry and telemetry emission off. Explicitly supplied
environment configuration is still respected.

## Architecture

```text
polished shipped renderer
          │
          │ desktop preload / RPC
          ▼
     Electron main
          │
          ├── settings, secrets, auth and plugin lifecycle
          ├── remote box connector
          └── owned local Docker connector
                       │
                       ▼
              coordinator + host
                       │
              inference router
           ┌───────────┼───────────┐
        Cursor      Claude       Codex / OpenRouter
                       │
                 Grok Bot MCP tools
```

The main source areas are:

- `source/electron-main/` — desktop lifecycle, settings, auth, box connectors,
  coordinator ownership, and RPC handlers;
- `source/server-main/` — Docker web control plane (HTTP, WebSocket shim, debug
  surface) used by `deploy/`;
- `source/electron-preload/` — the narrow trusted bridge exposed to the UI;
- `source/host/` — inference, tools, MCP, settings, and turn execution;
- `source/node-agent-coordinator/` — transcript routing, streaming activity,
  reactions, and the routed MCP bridge;
- `source/shared/` — shared contracts, settings, protocol, and provider helpers;
- `frontend/` — readable React/TypeScript renderer reconstruction and design
  workspace;
- `scripts/` — bootstrap, compilation, renderer patching, packaging, signing,
  and verification; and
- `tests/` — publication and router regressions.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for more detail.

## Development commands

```sh
npm test                  # focused regression tests
npm run typecheck         # renderer TypeScript
npm run source:typecheck  # runtime TypeScript
npm run frontend:build    # build the readable renderer reconstruction
npm run package           # build, sign, and verify the macOS app
npm run verify            # verify an existing packaged app
npm run smoke             # bounded native smoke check
npm run web:build         # compile the Docker web-runtime artifacts
npm run web:bootstrap     # stage the pinned 0.36.0 web renderer
```

Generated directories including `.cache`, `.build`, `dist`, `src/app/dist`,
`recovered`, `recovery`, and local probe roots are ignored.

## Project status

The app launches and the core reconstructed flows are usable, including routed
inference, connected plugins, and the local Docker sandbox. This is still an
experimental reconstruction: it targets one pinned macOS/arm64 release, depends
on external provider sessions, and does not promise compatibility with future
Grok Bot versions.

For changes, read [CONTRIBUTING.md](CONTRIBUTING.md). For the clean-history
export procedure, see [docs/PUBLISHING.md](docs/PUBLISHING.md). Technical
provenance and retained upstream boundaries are described in
[PROVENANCE.md](PROVENANCE.md) and [NOTICE.md](NOTICE.md).
