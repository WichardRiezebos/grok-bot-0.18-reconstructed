# Design parity with Grok Bot

This audit maps the behaviors described in SpaceXAI's design essay
["Designing Grok Bot for a world of persistent agents"](https://x.ai/news/designing-grok-bot)
(Sep 3, 2026) onto this reconstruction, with code evidence for each claim.
It is the working spec for closing behavioral gaps; statuses below drive the
prioritized delta list at the end.

Status legend:

- **Parity** — recovered code implements the described behavior.
- **Pinned** — behavior lives in the checksum-pinned shipped renderer
  (0.18 desktop / 0.36 web); parity is inherent, not re-implemented.
- **Delta** — our reconstruction deviates; tracked in the delta list.
- **Substitution** — intentionally replaced infrastructure (OpenRouter,
  local Docker box, no cloud backend); behavior preserved within the
  substitution's limits.

The shipped renderer is never modified outside the narrow deterministic
Router-settings transform, so visual parity is inherited, not audited here.
This document audits the runtime we reconstructed under it.

## 1. The five primitives

The essay names five concepts users need: Bots, Chats, Prompts, Tools,
Artifacts. Everything else stays beneath the interface.

| Primitive | Reconstruction evidence | Status |
| --- | --- | --- |
| Bots: persistent agents with identity, memory, runtime, tools | Per-agent SQLite session store with profiles (name, title, avatar color/shape): `source/host/extensions/session/agent-session.ts:96-99`; sessions materialize per agent: `source/host/extensions/session/session-materialization.ts:71` | Parity |
| Chats: the conversational interface | Transcript pages/windows/tails over per-agent DBs: `source/host/extensions/session/agent-db-transcript-pages.ts`; threads, reactions, send-message shaping under `source/host/extensions/transcript/` | Parity |
| Prompts: used once, saved as Skills, or triggered as Routines | Global workflow/skill library with managed + plugin skills (`SKILL.md`), publishing, and local import of `CLAUDE.md`/`AGENTS.md`/`.cursor/rules`: `source/host/workflows/workflow-store.ts:18-55`, `source/host/extensions/mcp/skill-publish.ts`; Routines are automations: `source/host/automations/automation.ts:85-90` | Parity |
| Tools: software, APIs, connectors, shell, computer use | MCP service + plugin (Composio) connectors: `source/host/extensions/mcp/mcp-service.ts`; local exec + computer use against the Docker box: `source/packages/local-exec/`, `source/box-exec-daemon/` | Substitution (Composio for cloud connectors) |
| Artifacts: durable outputs Bots create or modify | Attachment/media cards and media search: `frontend/src/recovered/features/conversation/cards/transcript-card/protocol.ts` (attachment card), `searchMedia` in `source/host/gateway-protocol.ts` | Parity |

## 2. From chat history to a Bot roster

The main objects are Bots, not conversations. The sidebar is a roster.

| Claim | Evidence | Status |
| --- | --- | --- |
| Roster with named, avatar-identified Bots | `frontend/src/recovered/features/conversation/workspace/sidebar.tsx` (sections, pins, reorder, rename, duplicate, hide, unread); roster projection/search: `source/host/extensions/transcript/roster-projection.ts`, `roster-search.ts` | Parity |
| Avatars recognizable at a glance; one visual system | Persona marks with deterministic color/shape per agent; group/shared-room composites: `frontend/src/recovered/features/conversation/workspace/agent-avatar.tsx:98-139` | Pinned (renderer) + Parity (dispatcher) |

## 3. Presence as interface

The essay describes avatar motion answering *who is this / what are they
doing / how much do I need to know*, with states idle, thinking, working,
waiting, blocked, done — and hover for the current action.

| Claim | Evidence | Status |
| --- | --- | --- |
| The avatar itself carries the lifecycle | Shipped state catalog of 38 persona states (idle, thinking, searching, working, orbit, loading, sending, alerting, celebrate, …): `frontend/src/recovered/features/onboarding/signed-in/scene.ts:8-14` | Parity |
| Activity → motion mapping | `ACTIVITY_TO_STATE` + tool-kind mapping: `frontend/src/recovered/features/conversation/workspace/agent-avatar.tsx:41-62` | Parity |
| Waiting has its own motion | `waiting`/`messaging` → `orbit` in the same table | Parity (mapping), Parity (wiring — verified) |
| Blocked / need-help has its own motion | The shipped 0.36 gate itself projects `awaitingUserResponse != null` → `"idle"` (`Ese` in the pinned main chunk: `t?.awaitingUserResponse!=null?jf` with `jf="idle"`), and surfaces need-help as the sidebar `"needs-attention"` marker instead of an avatar motion. Our `personaStateFromAgent` mirrors the shipped gate faithfully | Parity (verified against chunk evidence) |
| Done settles the avatar | Sidebar falls back to labels ("Needs attention", "Working") exactly as the shipped product does (`qPe` marker styles in the pinned chunk); no post-run settle motion exists in the shipped gate either | Parity (verified) |
| Hover shows the current action | `currentActivity` is projected into the avatar; hover surface lives in the pinned renderer | Pinned (verify visually) |
| Sidebar scan-ability without reading names | Avatar + status marker projection: `sidebar.tsx:113-118` | Parity |

## 4. Their computer, not yours

Three access levels: Status (title-bar signal), Preview (pinned side panel),
Takeover (full screen + hand back).

| Claim | Evidence | Status |
| --- | --- | --- |
| Status level: workspace state visible without opening | Box status store with read states, ensure/start, disk pressure, VNC presence: `frontend/src/recovered/features/computer/shell/status-store.ts` | Parity |
| Preview level: pinned panel to follow work | `open(trigger: "preview")` on the computer experience: `frontend/src/recovered/features/computer/shell/controller.ts:41-48` | Parity |
| Takeover level: take control and hand back | `handBackForeverBox` + `handBack(trigger: "button" \| "dismissed")`: `status-store.ts:53`, `controller.ts:45`; VNC webview lifecycle with crash recovery: `shell/vnc-webview.tsx` | Parity |
| Handoff requests appear in the transcript | `TranscriptComputerHandoff` → `cardFor(entry)` handoff cards: `controller.ts:26-31, 46` | Parity |
| VNC reachability through the gateway | noVNC primary/fork URL proxying with tokens: `source/node-agent-coordinator/gateway/box-vnc-proxy.ts` | Parity |
| The computer is the Bot's own | Per-agent Docker VM (`grok-bot-local-vm`), forever-box lifecycle (`ensureForeverBox`, hibernation, image updates): `computer-rebuild-box-store.ts`, `projectForeverBoxPhase` | Substitution (local Docker for cloud box) |
| Wallpapers shift through the day | Renderer asset | Pinned |

## 5. The shape of information

Responses use structured UI when prose does not fit; actions and system
events appear directly in the transcript.

| Claim | Evidence | Status |
| --- | --- | --- |
| Inline cards and widgets in the transcript | 12 recovered card types: `text`, `widget`, `cursor-agent`, `email-draft`, `slack-draft`, `auto-review-approval`, `listener-connect`, `secret-request`, `attachment`, `connector`, `connectors`, `local-tool-permission`: `frontend/src/recovered/features/conversation/cards/transcript-card/protocol.ts:10-23, 171-183` | Parity |
| Email compose card ("Ready to send" → Sent) | Editable draft with validation, collapse, send/discard, sent state: `frontend/src/recovered/features/conversation/cards/transcript-card/views/email-draft.tsx` | Parity |
| Routine actions appear in the transcript ("Created Routine") | Automation lifecycle diffs emit `type: "automation-changed"` entries: `source/host/extensions/transcript/automation-runtime.ts:136-173, 264-273` | Parity (entry), Pinned (rendering) |
| Bot-to-bot check-ins appear as objects ("6 messages with …") | The pinned 0.36 renderer carries the full special-message contract: `uu()` detects `fromAgent`/`toAgent` messages, resolves `agent:{id}` authorship, projects roles and display names, and knows the `automation-message` kind (pinned main chunk). Our readable workspace keeps `special-variant` unsupported pending recovery of that card contract — the running product is unaffected | Parity (pinned renderer); workspace note |
| Heterogeneous timeline (conversation, events, objects) | Message bubbles, cards, notices, handoffs, reactions share one transcript projection: `workspace/transcript-adjacency.ts` | Parity |
| Link previews as cards | URL-card provider with metadata fetch/cache/heal: `cards/transcript-card/url-card.ts`, `views/link-card.tsx` | Parity |

## 6. Organizing intelligence

Bots cooperate in groups; capabilities are shared account-wide while
context stays with the role.

| Claim | Evidence | Status |
| --- | --- | --- |
| Group chats with shared context | `createGroup`, `setGroupMembers`, shared rooms (typing, leave): `source/host/gateway-protocol.ts:29-30, 57-58`; group glue: `source/host/extensions/transcript/group-chat-glue.ts` | Parity |
| Six Bots per group chat | `GROUP_MAX_MEMBERS = 6` enforced in store normalization: `source/host/groups/group-store.ts:1-3`, `source/shared/agents/agents.ts:53` | Parity |
| Coordinating Bots route work | `SendToAgent`, `UpdateAgent`, `broadcastToAgents`, `kickstartAgent`: `source/host/gateway-protocol.ts:27, 65`; subagent orchestration: `source/shared/agents/subagents.ts` | Parity |
| Automations run inside groups | `runGroupAutomation` branch: `source/host/extensions/transcript/automation-run-path.ts:139, 205-217` | Parity |
| Capabilities account-wide (tools, skills) | Connector secrets per account: `agent-session.ts:79`; global workflow library + managed/plugin skills: `workflow-store.ts:26-27` | Parity |
| Context per Bot (memory, routines) | Per-agent memory store + per-agent automations/workflows: `session-materialization.ts:71`, `agent-session.ts:211-216` | Parity |
| Slack/GitHub listener integrations | Relay sources + listener connect watcher in the trigger hub: `source/host/extensions/automations/extension.ts:72-81` | Delta (needs cloud backend) — **not reachable in OpenRouter mode** |

## 7. Work that keeps moving

Routines run on a schedule or in response to an event; a prompt can be a
schedule, an event, or another Bot.

| Claim | Evidence | Status |
| --- | --- | --- |
| Routine CRUD, enable/disable, run-now, run history, notices | `automation-runtime.ts:386-459`, store: `source/host/automations/automation-store.ts`, UI controller: `frontend/src/recovered/features/automations/routines/controller.ts` | Parity |
| Cron and event triggers; event batching/coalescing; overflow shedding | `source/host/extensions/transcript/automation-event-fires.ts:42-90` | Parity |
| Runs happen without a user present (background sessions, hidden turns) | `resolveBackgroundSession` + hidden runner run: `automation-run-path.ts:135, 226-246` | Parity |
| Spend guard pauses background work when the user is away | `AutomationSpendGuardRuntime` gating + `user_away_paused` drop reports: `automation-run-path.ts:142-157` | Parity |
| Scheduled routines fire without the app open | Upstream schedules **cloud-side** and delivers fires via `SandAutomationFireConsumer` (auth + backend URL + notify bus): `automations/extension.ts:73-76`. Our deployment has no cloud backend: auth is stubbed (`authId: "local"`, `source/server-main/rpc.ts:115`), so `peekAccessToken()` is null, cloud reconcile never yields "known" evidence, and `shouldScheduleLocally` returns `false` for every server-schedulable routine (`sand-automation-cloud-sync.ts:372-379`). The trigger hub itself has **no cron loop** — it only drives event listeners (`sand-trigger-hub.ts`). **Fixed by D-P1 below**: a local due-run scheduler fires cron routines when no cloud credential exists | **Delta D-P1 — fixed** |
| Event routines fire on triggers | Composio triggers enter via the gateway and bypass the cloud gate: `source/host/host-gateway-api.ts:433-451` → `runAutomationForEvent`; webhook surface documented in `docs/REMOTE-RUNTIME.md` | Parity (Composio), Delta (Slack/GitHub relays need cloud) |
| Bots keep running after the tab closes (web) | The web runtime bundles the full production host, including the automations extension: `scripts/build-web-runtime.mjs:64-105`, bindings in `source/host/host-production-extensions.ts:112` | Parity architecturally; blocked for cron by D-P1 |
| ~50 Bots per account | `MAX_AGENTS_PER_USER = 50` with reclaim + `SandAgentLimitError` (HTTP 409): `session-materialization.ts:11-14, 96`, `source/host/gateway-server.ts:15` | Parity |

## 8. Memory

Bots remember their conversations across sessions.

| Claim | Evidence | Status |
| --- | --- | --- |
| Per-agent memory stores | `SessionMemoryProvider` + `createMemoryStore` wired into session materialization: `agent-session.ts:32, 69, 84-85`, `session-materialization.ts:71`, extension wiring: `extensions/transcript/extension.ts:70`, `extensions/session/production.ts:184` | Parity (wiring); **D-P4: verify the provider's substance in OpenRouter mode** (default is `NO_SESSION_MEMORY`) |
| Bots build and use long-term memory | `MemorySynthesisService` with real debounce/deadline/retry policies synthesizes durable memory through the inference port (`extensions/memory/production.ts:43-75`); the `sand_memory_dreaming` gate defaults **on** without an authenticated Statsig bootstrap (`extensions/experiments/extension.ts:12-16, 31`), so synthesis runs in OpenRouter mode; summarization sessions route to the configured OpenRouter summarize model (`inference-service.ts:64-67`, `resolveOpenRouterSummarizeModel`) | Parity (verified — D-P4 resolved) |

## Delta list

Priorities ordered by how much they move the product toward the essay's
"persistent agents" thesis. Web/Dokploy deployment first.

### D-P1 — Scheduled routines never fire (high) — FIXED

Upstream delegates cron scheduling to its cloud; this reconstruction has no
cloud. Event routines (Composio) already fire; cron routines did not.

Fix (landed): `source/host/extensions/automations/local-due-run-scheduler.ts`,
wired in `source/host/extensions/automations/extension.ts`. When
`deps.auth.peekAccessToken() == null`, a 30s polling pass:

- lists automations via the transcript manager (`listAllAutomations`, which
  returns store-derived `nextRunAt` anchored on the persisted `lastRunAt`);
- fires each enabled routine whose slot has arrived through the same
  `runServerScheduledAutomation` seam the cloud consumer uses, so spend
  guard, background sessions, hidden wake turns, run history, and in-flight
  dedup behave identically to cloud-delivered fires;
- derives a stable per-slot `runUuid` (`local-{agentId}-{automationId}-{nextRunAt}`);
  because `recordAutomationRun` advances `lastRunAt` at run start, the anchor
  moves past the slot and the same occurrence cannot fire twice — including
  across host restarts (`lastRunAt` is persisted in `automation.json`);
- catches up at most the one missed slot after downtime (no historical
  backfill, matching upstream fire delivery);
- stands down per pass while a cloud credential exists (scheduling returns to
  the cloud) and while `turn-execution.isRunReady()` is false; participates in
  `suspendWakes`/`resumeWakes`.

Observability: each start and firing logs a `[sand:automations]` line on the
host (visible in the box container logs in the web deployment); the latest
pass (due/fired/skips/lastError) is exposed via
`getLocalDueRunSchedulerStatus()` on the extension. A dedicated `/debug` row
would need new gateway plumbing and is deferred.

Tests: `tests/local-due-run-scheduler.test.mjs` — due-slot selection, stable
per-slot runUuid, seam arguments, cloud/not-ready stand-down, failure
isolation across rows, and stop semantics.

### D-P2 — Presence states collapsed — RESOLVED AS PARITY (verified)

The audit originally flagged `personaStateFromAgent`'s `awaitingUserResponse`
→ `idle` mapping as a divergence from the essay. Chunk evidence from the
pinned 0.36 renderer proves the shipped product behaves the same way: the
`Ese` presence gate returns `"idle"` when `awaitingUserResponse != null`, and
need-help surfaces as the sidebar `"needs-attention"` marker rather than a
distinct avatar motion. Our reconstruction mirrors the shipped gate
faithfully; the essay's "waiting/blocked/done" motions are its marketing-level
summary of the same system. No code change required.

### D-P3 — Agent-to-agent message cards — RESOLVED AS PARITY (verified)

The pinned 0.36 renderer contains the complete special-message contract
(`fromAgent`/`toAgent` detection, agent author resolution, i18n display
names, `automation-message` kind), so the running app renders bot-to-bot
traffic as designed. Only the readable `frontend/` design workspace keeps
`special-variant` unsupported (`message-card-seam.ts:152`), pending recovery
of that card contract from the chunks; this affects no shipped behavior.

### D-P4 — Memory substance in OpenRouter mode — RESOLVED AS PARITY (verified)

The memory pipeline is substantive in this reconstruction, not a stub:

- Synthesis is enabled by default without cloud auth: the experiments gate
  `sand_memory_dreaming` resolves via `localGateOrDefault`, which returns the
  local default `true` when there is no authenticated Statsig bootstrap
  (`source/host/extensions/experiments/extension.ts:12-16, 31`).
- `MemorySynthesisService` runs with real debounce/deadline/retry policies and
  synthesizes through the inference port into per-agent stores
  (`source/host/extensions/memory/production.ts:43-75`).
- Summarization sessions route to the configured OpenRouter summarize model in
  non-Cursor mode (`source/host/extensions/inference/inference-service.ts:64-67`).
- Per-agent memory stores feed session materialization
  (`session-materialization.ts:71`) and the transcript manager
  (`extensions/transcript/extension.ts:70`).

### D-P5 — Slack/GitHub listener integrations (low, accept)

Requires the cloud backend. Accept as not-applicable in OpenRouter mode;
document here rather than re-implementing relay sources.

## Verification loop

- `npm test` — regressions for each fixed delta
- `npm run source:typecheck` and `npm run web:build`
- Local compose overlay (`http://127.0.0.1:8080`) + `/health` + `/debug`:
  create a cron routine, close the tab, confirm the run fires and the
  transcript records it (D-P1 acceptance)
