# OpenRouter model steering

Study of how Grok Bot should pick OpenRouter models. Prices are listed $/M tokens on OpenRouter as of 28 August 2026. This document does not change routing code.

A ranked canvas lives beside chat: open [`openrouter-model-steering.canvas.tsx`](/Users/wichard/.cursor/projects/Users-wichard-ghq-github-com-b-nnett-grok-bot-0-18-reconstructed/canvases/openrouter-model-steering.canvas.tsx).

## What the bot actually does

Native Cursor-path Grok Bot already steers by **task type**, not by thinking vs screen vs click:

| Native slot | Model | Notes |
| --- | --- | --- |
| Think / chat | `grok-4.5` | High effort, max mode ([`source/host/extensions/inference/cursor-session.ts`](../source/host/extensions/inference/cursor-session.ts)) |
| Drive the box | `claude-opus-4-8` | Computer-use subagent, thinking off, effort low ([`source/shared/agents/sand-agent-model.ts`](../source/shared/agents/sand-agent-model.ts)) |
| Summarize | `gemini-2.5-flash` | Memory / compaction ([`source/shared/agents/sand-agent-model.ts`](../source/shared/agents/sand-agent-model.ts)) |

OpenRouter settings today expose two slots ([`scripts/lib/router-renderer-patch.mjs`](../scripts/lib/router-renderer-patch.mjs)):

- **Chat model** — “thinking, chat, and turns without Computer”
- **Computer model** — “when the agent drives the box screen”

The Computer slot is already screen **and** click together. That matches the runtime: one `streamText` loop, last three screenshots kept, `Computer` tool emits `screenshot | click | type | key | scroll | wait` ([`source/shared/routed-computer-tools.ts`](../source/shared/routed-computer-tools.ts), [`source/host/extensions/inference/provider-session.ts`](../source/host/extensions/inference/provider-session.ts)).

### Steering bug

Computer tools are always listed. `listRoutedComputerTools` is unconditional in [`source/node-agent-coordinator/inference-router.ts`](../source/node-agent-coordinator/inference-router.ts). `openRouterExecutor` then picks the computer model whenever Computer is in the tool list.

So the Chat model is rarely used. A plain “hello” still pays for a vision GUI model at computer reasoning (`low`).

The recommended catalog is also stale: `x-ai/grok-4` (gone), `anthropic/claude-sonnet-4.5`, `qwen/qwen3.7-flash` ([`source/shared/openrouter-models.ts`](../source/shared/openrouter-models.ts)). Qwen 3.7 Flash was already dropped as the computer default (`SAND_DROP_QWEN_COMPUTER_MODEL_MIGRATION_ID` in [`source/shared/node/settings/sand-settings-store.ts`](../source/shared/node/settings/sand-settings-store.ts)).

**First steering fix (later, not this study):** attach Computer tools only when the turn needs the screen, so Think is actually used.

## Do not split Screen vs Click

Native Grok Bot does not split vision from clicks. Research (Gelato + a planner, UI-TARS) shows planner + grounder can work, but it is the wrong first architecture here:

- This bot’s Computer tool is one see-act-verify loop (up to 32 steps). A second model per step adds latency and coordinate drift.
- Specialists like `bytedance/ui-tars-1.5-7b` ($0.10 / $0.20) speak their own GUI action format, not this schema. They need an adapter, not a dropdown.
- Plugin / MCP calling is the same skill as Think. Auto-review still runs on the Cursor classifier, not OpenRouter.

**Recommended slots (three, matching native):** Think, Drive, Summarize. Keep Screen+Click on Drive. Add a Ground slot only later if Drive click accuracy is still bad.

## Ranked OpenRouter models per task

Cost bands: **High** = best / most expensive, **Med** = default pick, **Low** = cheapest that still fits the job. All IDs are live OpenRouter slugs. Think and Drive must support tools; Drive also needs image input.

### 1. Think — chat, plugins, planning

Needs: tool calling, instruction following, long context. No screenshots if Computer is gated.

| Tier | Model | Listed $/M | Context | Why |
| --- | --- | ---: | --- | --- |
| High | `anthropic/claude-opus-4.6` | $5 / $25 | 1M | Best long-horizon agent and plugin reliability. Cache reads ~$0.50/M. |
| Med | `x-ai/grok-4.6` | $2 / $6 | 500K | Native Grok Bot voice, frontier coding/STEM, cheaper than Sonnet. Default Think pick. |
| Low | `google/gemini-3.7-flash` | $0.375 / $1.875 | 1M | Fast agentic workflows with tools. Vertex promo; full listed rate is $1.50 / $7.50. |

Runner-up med: `anthropic/claude-sonnet-4.6` ($3 / $15) if you want Claude-family Think. Current default `openai/gpt-4.1` ($2 / $8) is a solid med but older than Grok 4.6 / Sonnet 4.6.

Effort: medium for med/high, low for Gemini Flash.

### 2. Drive — screen + click (one model)

Needs: screenshot understanding, pixel-grounded clicks, OpenAI-style tools, low extra thinking (native: thinking off, effort low). Screenshots dominate cost (up to 32 steps, three images kept).

| Tier | Model | Listed $/M | Context | Why |
| --- | --- | ---: | --- | --- |
| High | `anthropic/claude-opus-4.6` | $5 / $25 | 1M | Matches native computer-use (Opus-class). Use only when shopping/GUI must not miss. |
| Med | `anthropic/claude-sonnet-4.6` | $3 / $15 | 1M | OpenRouter copy calls out “confident computer use.” Default Drive pick. |
| Low | `anthropic/claude-haiku-4.5` | $1 / $5 | 200K | Marketed as matching Sonnet 4 on computer-use; ~0.5s; still this tool schema. |

Budget escape hatch (not the ranked Low): `qwen/qwen3.8-flash` ($0.15 / $0.47), multimodal, “desktop interaction,” tools — but 3.7 Flash was already dropped for quality. Effort: **low** on all Drive tiers.

Do **not** put UI-TARS in this slot without an adapter.

### 3. Summarize — memory / compaction

Native already uses a cheap flash model. The OpenRouter path currently reuses the chat/computer model for this; there is no Summarize dropdown yet.

| Tier | Model | Listed $/M | Context | Why |
| --- | --- | ---: | --- | --- |
| High | `google/gemini-2.5-pro` | $1.25 / $10 | 1M | Overkill. Only if summaries must be very faithful. |
| Med | `google/gemini-2.5-flash` | $0.30 / $2.50 | 1M | Native’s summarizer. Default. |
| Low | `qwen/qwen3.8-flash` | $0.15 / $0.47 | 1M | Cheap long-context rewrite. |

### If you still want Screen vs Click

Only useful after a grounder adapter exists.

| Slot | High | Med | Low |
| --- | --- | --- | --- |
| Screen (describe UI) | `qwen/qwen3-vl-235b-a22b-thinking` ($0.40 / $4) | `google/gemini-3.7-flash` | `bytedance/ui-tars-1.5-7b` ($0.10 / $0.20) |
| Click (coords) | `anthropic/claude-opus-4.6` | `anthropic/claude-sonnet-4.6` | `anthropic/claude-haiku-4.5` |

UI-TARS as click-only still needs format translation into this bot’s Computer JSON schema.

## Suggested presets (later UI)

| Pack | Think | Drive | Summarize |
| --- | --- | --- | --- |
| High | `anthropic/claude-opus-4.6` | `anthropic/claude-opus-4.6` | `google/gemini-2.5-flash` |
| Med (recommended) | `x-ai/grok-4.6` | `anthropic/claude-sonnet-4.6` | `google/gemini-2.5-flash` |
| Low | `google/gemini-3.7-flash` | `anthropic/claude-haiku-4.5` | `qwen/qwen3.8-flash` |

Refresh `RECOMMENDED_OPENROUTER_MODEL_IDS` later to those six (drop grok-4, sonnet-4.5, llama-4-maverick, qwen3.7-flash).

## Sources

- OpenRouter model pages for the IDs above, fetched 28 August 2026.
- Native model split: [`source/shared/agents/sand-agent-model.ts`](../source/shared/agents/sand-agent-model.ts), [`source/host/extensions/inference/cursor-session.ts`](../source/host/extensions/inference/cursor-session.ts).
- OpenRouter executor and Computer tool list: [`source/host/extensions/inference/provider-session.ts`](../source/host/extensions/inference/provider-session.ts), [`source/node-agent-coordinator/inference-router.ts`](../source/node-agent-coordinator/inference-router.ts), [`source/shared/routed-computer-tools.ts`](../source/shared/routed-computer-tools.ts).
