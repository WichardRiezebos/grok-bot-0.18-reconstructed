# Prompt leak audit — asgeirtj `xAI/grok-bot.md` vs Grok Bot 0.18.0

- Leak: <https://raw.githubusercontent.com/asgeirtj/system_prompts_leaks/refs/heads/main/xAI/grok-bot.md> (~306 KB, fetched 2026-09-03). The raw file is **not committed**; a copy lives in the gitignored scratch dir (`.cache/leak/grok-bot.md`) alongside the diff/anchor scripts used for this audit.
- Ground truth for this repo: the pinned 0.18.0 `app.asar` (`.cache/runtime/Grok Bot.app/Contents/Resources/app.asar`, 74.9 MB, stores unminified JS with `// src/...` headers). The leak is **third-party material from a different build** and is treated as a hint index only (PROVENANCE.md evidence-only rule).

## Verdict

Fuzzy measurement (normalized word 4-gram containment of each leak section against rendered reconstruction artifacts, `.cache/leak/audit-fuzzy.mjs` → `audit-fuzzy.json`):

- **Base prompt 1.1–1.23, 1.25, 1.29, 1.32–1.33: 0.92–1.00** — byte-faithful reconstruction (`source/host/runner/system-prompt.ts:77+`, `sand-multitask.ts`, `automations/automation.ts`, addenda). Nothing to adopt.
- **1.24 Untrusted content** exists in 0.18 (`shared/sand-spotlight.ts`, asar window dump `.cache/leak/binary/1.24_Untrusted_content.txt`) and was already reconstructed 1:1; the shipped app attaches it via `sand_spotlight`.
- **1.26–1.31, 1.34** are reconstructed in their run-time homes (`prompt-collector-glue.ts` Your box/box desktop, `shared/timezone.ts`, `shared/mcp-custom-instructions.ts`, channels/agent-directory renderers, `extensions/memory/memory-service.ts` templates) and reach turns via `system-prompt-assembly.ts`.
- ****Not adopted — different build**:
  - 0.18 ships a **generic** subagent prompt (`You are Grok Bot running as the ${subagentType} subagent.` + delivery + safety section, asar `@45571193`); the leak's per-type specialist prompts (§2.1–2.9) are from a newer build, and 0.18's anchor texts for debug/videoReview/vmSetupHelper/cursor-guide/explore exhibit none of that prose.
  - The leak's `browser_*` tool family is absent from the 0.18 asar (0.18 uses `Computer`/`observe_ui`/`act_ui`/`box_chrome`); its "connects **local ones** (MCP servers)" wording is also absent.
  - §3 tool docs differ accordingly; the reconstruction's tool descriptions already match the pinned binary.

## Gaps found in this repo (and adopted here)

1. **Routed-path untrusted-content defense** — leaked-and-binary-confirmed section was never attached on OpenRouter turns, and tool results were delivered raw. Adopted: fence routed tool results + attach the section (opt-out `SAND_ROUTE_SPOTLIGHT=0`).
   - `source/shared/routed-computer-tools.ts` — `openRouterToolResultContent`/`codexFunctionCallOutput`/`routedSpotlightWrappingEnabled`.
   - `source/host/extensions/inference/pi-drive-session.ts` — drive-slot tool results fenced with the tool name as source.
   - `source/host/runner/routed-system-prompt.ts` — `## Untrusted content` (`canSendMessage:false` wording) in both slots, env `options.env` injectable.
   - `source/host/extensions/inference/codex-direct-responses.ts` — source label forwarded.
2. **Runner+OpenRouter fan-out dropped `pluginTools`** — the overlay claimed "No Connect plugins are attached" even when plugin tools were attached. Adopted: `routedDefinitionsHavePluginTools` (name-based, native-tool allowlist) in `routed-computer-tools.ts`; `ProviderPromptExecutor.stream` (`provider-session.ts:423`) derives and forwards it.
3. **No-Cursor gate defaults** — `sand_memory_dreaming` and `sand_browser_use_subagent` default OFF and `pinGateOnAuthenticatedBootstrap` never fires without a Cursor session, keeping memory synthesis and the browserUse subagent permanently dark on routed/local runtimes. Adopted: no-auth default ON with env overrides `SAND_MEMORY_DREAMING=0` / `SAND_BROWSER_USE_SUBAGENT=0` (`source/host/extensions/experiments/extension.ts`, consumed by `extensions/memory/extension.ts`); authenticated sessions keep live Statsig semantics.

## Dropped deliberately

- `SAND_MULTITASK=1` baking: `sand_multitask` bundled default is **true** (experiment-config.gen.ts:135), so multitask (TodoWrite + executor subagent + section) is already on when no Statsig backend resolves.
- Spotlight on the *runner* path: `sand_spotlight` bundled default is **true** (experiment-config.gen.ts:704), so `getSystemPrompt` already attaches it; the coordinator path is the only gap (fixed above).
- All leak-only behavior above (local MCP connectors, per-type subagent prompts, `browser_*` toolset).

## Verification

- `tests/routed-usefulness.test.mjs` — fence shape + opt-out, plugin-tool detection, section presence/opt-out, subagent-prompt binary-fidelity guard.
- Updated for the fenced contract: `tests/routed-computer-tools.test.mjs`, `tests/codex-direct-responses.test.mjs`.
- Full suite: 177 pass / 0 fail. `source:typecheck` — no new errors (4 pre-existing baseline failures unchanged).
- Known flaky, pre-existing: `tests/inference-router-transcript.test.mjs` "stopRoutedTurn stays idle…" can hit `ENOTEMPTY` on temp-dir cleanup (reproduces on a pristine tree).
