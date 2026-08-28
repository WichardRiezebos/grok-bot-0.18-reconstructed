import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import { appendRoutedInferenceLog, isRoutedPromptOverflowError, isRoutedTransientProviderError, routedRouterErrorText, routedSettledAssistantContent } from "../shared/routed-inference-log.js";
import {
  ROUTED_COMPUTER_INFERENCE_TURN_TIMEOUT_MS,
  ROUTED_COMPUTER_MAX_STEPS,
  ROUTED_COMPUTER_SCREENSHOT_LOOP_LIMIT,
  ROUTED_INFERENCE_TURN_TIMEOUT_MS,
  ROUTED_PLUGIN_MAX_STEPS,
  computerScreenshotLoopMessage,
  ROUTED_BOX_CHROME_TOOL_NAME,
  extractRoutedBrowserUrl,
  isRoutedComputerTool,
  mergeRoutedToolLists,
  nextComputerScreenshotStreak,
  routedBoxChromeAlreadyOpenMessage,
  routedBoxChromeUrl,
  routedBoxHelpHandoff,
  routedComputerActionName,
  routedComputerBlockedByHandoffMessage,
  routedComputerMcpResult,
  routedToolsIncludeComputer,
  shouldSkipRoutedBoxChromeReload,
} from "../shared/routed-computer-tools.js";
import type { SandInferenceProvider } from "../shared/inference-router.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { createRoutedMcpBridge } from "./routed-mcp-bridge.js";

export {
  ROUTED_COMPUTER_INFERENCE_TURN_TIMEOUT_MS,
  ROUTED_COMPUTER_MAX_STEPS,
  ROUTED_INFERENCE_TURN_TIMEOUT_MS,
  ROUTED_PLUGIN_MAX_STEPS,
};
export {
  isRoutedPromptOverflowError,
  isRoutedTransientProviderError,
};

export const ROUTED_TURN_RETRY_BACKOFF_MS = [2_000, 8_000] as const;
export const ROUTED_TURN_MAX_RETRIES = 2;
export const ROUTED_STREAM_EMIT_THROTTLE_MS = 250;

type StoredEntry = {
  readonly provider: Exclude<SandInferenceProvider, "cursor">;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly richText?: string;
  readonly id: string;
  readonly clientNonce?: string;
  readonly reactions?: readonly { readonly emoji: string; readonly by: string }[];
  readonly timestampMs: number;
  readonly boxRequestId?: string;
  readonly boxInstruction?: string;
};
type Store = { readonly schemaVersion: 2; readonly agents: Readonly<Record<string, readonly StoredEntry[]>> };

const EMPTY_STORE: Store = { schemaVersion: 2, agents: {} };

export function coalesceRoutedProviderMessages(entries: readonly { readonly role: string; readonly content: string }[]): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const entry of entries) {
    const role = entry.role === "assistant" ? "assistant" : "user";
    const content = entry.content.trim();
    if (content.length === 0) continue;
    const last = messages.at(-1);
    if (last != null && last.role === role) last.content = `${last.content}\n\n${content}`;
    else messages.push({ role, content });
  }
  return messages;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function awaitRoutedRetryBackoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("The routed request timed out.");
  }
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("The routed request timed out."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseInferenceRouterTranscriptStore(value: unknown): Store {
  const root = asRecord(value);
  if (root?.schemaVersion !== 2 || asRecord(root.agents) == null) return EMPTY_STORE;
  const agents: Record<string, StoredEntry[]> = {};
  for (const [agentId, rawEntries] of Object.entries(root.agents as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) continue;
    const entries: StoredEntry[] = [];
    for (const raw of rawEntries) {
      const row = asRecord(raw);
      if (row == null || !["codex", "claude-code", "openrouter"].includes(String(row.provider)) || !["user", "assistant"].includes(String(row.role)) || typeof row.content !== "string" || typeof row.id !== "string" || typeof row.timestampMs !== "number" || (row.clientNonce !== undefined && typeof row.clientNonce !== "string") || (row.richText !== undefined && typeof row.richText !== "string") || (row.boxRequestId !== undefined && typeof row.boxRequestId !== "string") || (row.boxInstruction !== undefined && typeof row.boxInstruction !== "string")) continue;
      if (row.reactions !== undefined && (!Array.isArray(row.reactions) || row.reactions.some(reaction => asRecord(reaction) == null || typeof asRecord(reaction)!.emoji !== "string" || typeof asRecord(reaction)!.by !== "string"))) continue;
      entries.push(row as unknown as StoredEntry);
    }
    agents[agentId] = entries.slice(-200);
  }
  return { schemaVersion: 2, agents };
}

export function overlayRoutedRosterLastEntry(
  agents: unknown,
  store: { readonly agents: Readonly<Record<string, readonly { readonly id: string; readonly content: string; readonly timestampMs: number }[]>> },
): unknown {
  if (!Array.isArray(agents)) return agents;
  return agents.map(raw => {
    const row = asRecord(raw);
    if (row == null) return raw;
    const id = typeof row.id === "string" ? row.id : "";
    const entries = store.agents[id];
    if (entries == null || entries.length === 0) return raw;
    const last = entries.at(-1);
    if (last == null) return raw;
    const text = last.content.trim();
    if (text.length === 0) return raw;
    return {
      ...row,
      lastEntry: { kind: "text", text },
      lastMessageId: last.id,
      lastMessagePreview: text,
      updatedAt: last.timestampMs,
    };
  });
}

export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  return entry.role === "user"
    ? { kind: "message", id: entry.id, role: "user", content: entry.content, ...(entry.richText === undefined ? {} : { richText: entry.richText }), isStreaming: false, timestampMs: entry.timestampMs, ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }), ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) }
    : {
        kind: "send-message",
        id: entry.id,
        message: { type: "text", content: entry.content },
        timestampMs: entry.timestampMs,
        ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }),
        ...(entry.boxRequestId == null ? {} : { boxRequestId: entry.boxRequestId, boxInstruction: entry.boxInstruction ?? entry.content }),
      };
}

export function createCoordinatorInferenceRouter(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  readonly now?: () => number;
  readonly composingDelayMs?: number;
  readonly retryBackoffMs?: readonly number[];
  readonly runProviderText?: typeof runRoutedProviderText;
}) {
  const settings = new SandSettingsStore(join(options.dataDir, "settings.json"));
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<unknown>>();
  const streamingByAgent = new Map<string, { readonly id: string; readonly content: string; readonly timestampMs: number }>();
  const chromeOpenByAgent = new Set<string>();
  let storeLock = Promise.resolve();
  let snapshot: Store = EMPTY_STORE;
  const remember = (store: Store): Store => {
    snapshot = store;
    return store;
  };
  const withStore = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = storeLock.then(fn, fn);
    storeLock = next.then(() => undefined, () => undefined);
    return next;
  };

  const load = async (): Promise<Store> => {
    try { return remember(parseInferenceRouterTranscriptStore(JSON.parse(await readFile(storePath, "utf8")))); }
    catch { return remember(EMPTY_STORE); }
  };
  const persist = async (store: Store): Promise<void> => {
    remember(store);
    await mkdir(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storePath);
  };
  const overlayAgents = (payload: unknown): unknown => {
    const record = asRecord(payload);
    if (record == null || !Array.isArray(record.agents)) return payload;
    return { ...record, agents: overlayRoutedRosterLastEntry(record.agents, snapshot) };
  };
  const append = async (agentId: string, entries: readonly StoredEntry[]): Promise<Store> => withStore(async () => {
    const current = await load();
    const next: Store = { schemaVersion: 2, agents: { ...current.agents, [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-200) } };
    await persist(next);
    return next;
  });
  const emitTranscript = (agentId: string, type: "appended" | "updated", entry: Record<string, unknown>) => options.postEvent("transcript", { type, entry, agentId });
  type RoutedActivity = { kind: "thinking" } | { kind: "tool"; tool: string; callId: string; detail?: string };
  type TurnActivity = { stop(): void; reveal(next: { composing?: boolean; activity?: RoutedActivity }): void };
  const idleTurnActivity = (): TurnActivity => ({ stop() {}, reveal() {} });
  const beginActivity = async (agentId: string): Promise<TurnActivity> => {
    try {
      let remote = await options.dispatchRemote("listAgents", {});
      if (!Array.isArray(remote)) return idleTurnActivity();
      const surface: { composing: boolean; activity: RoutedActivity } = { composing: true, activity: { kind: "thinking" } };
      const project = (isRunning: boolean, roster: unknown[]) => overlayRoutedRosterLastEntry(roster.map(raw => {
        const row = asRecord(raw);
        if (row?.id !== agentId) return raw;
        return { ...row, isRunning, isRunningTurn: isRunning, isComposingMessage: isRunning && surface.composing, isRetrying: false, ...(isRunning ? { currentActivity: surface.activity } : { currentActivity: undefined }) };
      }), snapshot);
      const publishRunning = () => options.postEvent("agents", { activeAgentId: agentId, agents: project(true, Array.isArray(remote) ? remote : []) });
      publishRunning();
      const pulse = setInterval(() => {
        void options.dispatchRemote("listAgents", {}).then(next => {
          if (Array.isArray(next)) remote = next;
          publishRunning();
        }).catch(() => publishRunning());
      }, 250);
      pulse.unref();
      return {
        reveal(next) {
          if (next.composing !== undefined) surface.composing = next.composing;
          if (next.activity !== undefined) surface.activity = next.activity;
          publishRunning();
        },
        stop() {
          clearInterval(pulse);
          options.postEvent("agents", { activeAgentId: agentId, agents: project(false, Array.isArray(remote) ? remote : []) });
        },
      };
    } catch { return idleTurnActivity(); }
  };
  const toggleLocalReaction = async (agentId: string, entryId: string, emoji: string): Promise<Record<string, unknown> | null> => withStore(async () => {
    const trimmed = emoji.trim();
    if (agentId.length === 0 || entryId.length === 0 || trimmed.length === 0) return null;
    const current = await load();
    const entries = current.agents[agentId];
    if (entries == null) return null;
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0) return null;
    const before = entries[index]!;
    const reactions = before.reactions ?? [];
    const exists = reactions.some(reaction => reaction.emoji === trimmed && reaction.by === "me");
    const nextReactions = exists ? reactions.filter(reaction => !(reaction.emoji === trimmed && reaction.by === "me")) : [...reactions, { emoji: trimmed, by: "me" }];
    const { reactions: _oldReactions, ...withoutReactions } = before;
    const updated: StoredEntry = nextReactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions: nextReactions };
    const nextEntries = [...entries];
    nextEntries[index] = updated;
    await persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } });
    return projectInferenceRouterTranscriptEntry(updated);
  });
  const execute = async (provider: Exclude<SandInferenceProvider, "cursor">, args: Record<string, unknown>) => {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const richText = typeof args.richText === "string" ? args.richText : undefined;
    const clientNonce = typeof args.clientNonce === "string" ? args.clientNonce : randomUUID();
    if (agentId.length === 0 || prompt.length === 0) throw new Error("Local inference routing requires an agentId and prompt");
    const timestampMs = now();
    const [remote, beforeUser] = await Promise.all([options.dispatchRemote("getAgentTranscriptTail", { id: agentId }), load()]);
    const remoteEntries = Array.isArray(asRecord(remote)?.entries) ? asRecord(remote)!.entries as unknown[] : [];
    const remoteTurn = remoteEntries.reduce<number>((highest, raw) => {
      const id = asRecord(raw)?.id;
      const match = typeof id === "string" ? /^t(\d+)(?:u|s\d+)$/.exec(id) : null;
      return match == null ? highest : Math.max(highest, Number(match[1]));
    }, -1);
    const localTurn = (beforeUser.agents[agentId] ?? []).reduce((highest, entry) => {
      const match = /^t(\d+)(?:u|s\d+)$/.exec(entry.id);
      return match == null ? highest : Math.max(highest, Number(match[1]));
    }, -1);
    const turn = Math.max(remoteTurn, localTurn) + 1;
    const userEntry = { kind: "message", id: `t${turn}u`, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), isStreaming: false, timestampMs, clientNonce };
    if ((beforeUser.agents[agentId] ?? []).length > 0) chromeOpenByAgent.add(agentId);
    const withUser = await append(agentId, [{ provider, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), id: userEntry.id, clientNonce, timestampMs }]);
    emitTranscript(agentId, "appended", userEntry);
    const turnActivity = await beginActivity(agentId);
    // The shipped transcript intentionally suppresses its activity row as soon as
    // the first streamed assistant entry arrives. Direct providers can produce that
    // first delta in the same renderer reconciliation window as the roster update,
    // making the genuine composing state imperceptible. The shipped virtualized
    // transcript needs roughly 350 ms to materialize its trailing activity row,
    // so keep the composing state authoritative long enough for a clearly
    // perceptible rendered interval before normal token streaming begins.
    await new Promise<void>(resolve => setTimeout(resolve, options.composingDelayMs ?? 1_200));
    const messages = coalesceRoutedProviderMessages(withUser.agents[agentId] ?? []);
    let assistantSlot = 0;
    let assistantTimestampMs = now();
    let assistantId = `t${turn}s${assistantSlot}`;
    let assistantStreamStarted = false;
    const emitAssistant = (nextContent: string, streaming: boolean, id = assistantId, timestampMs = assistantTimestampMs) => {
      const entry = { kind: "send-message", id, message: { type: "text", content: nextContent }, streaming, timestampMs };
      emitTranscript(agentId, assistantStreamStarted ? "updated" : "appended", entry);
      assistantStreamStarted = true;
    };
    const advanceAssistantSlot = () => {
      assistantSlot = assistantSlot === 0 ? 2 : assistantSlot + 1;
      assistantId = `t${turn}s${assistantSlot}`;
      assistantTimestampMs = now();
      assistantStreamStarted = false;
    };
    const log = (message: string) => appendRoutedInferenceLog(options.dataDir, `${provider} ${agentId} ${message}`);
    const listRoutedTools = async (): Promise<unknown[]> => {
      const [computer, plugins] = await Promise.all([
        options.dispatchRemote("listRoutedComputerTools", {}),
        options.dispatchRemote("listRoutedMcpTools", {}),
      ]);
      return mergeRoutedToolLists(Array.isArray(computer) ? computer : [], Array.isArray(plugins) ? plugins : []);
    };
    let visibleText = "";
    let persistChain = Promise.resolve();
    let persistFailed: unknown;
    let stepUsedTool = false;
    let finishedSteps = 0;
    let attemptHadProgress = false;
    let lastStreamEmitAt = 0;
    let lastSettled: { readonly id: string; readonly content: string; readonly timestampMs: number } | undefined;
    const rememberStreaming = (content: string, id = assistantId, timestampMs = assistantTimestampMs) => {
      streamingByAgent.set(agentId, { id, content, timestampMs });
    };
    const clearStreaming = (id?: string) => {
      const live = streamingByAgent.get(agentId);
      if (live == null) return;
      if (id != null && live.id !== id) return;
      streamingByAgent.delete(agentId);
    };
    const persistThenEmit = (id: string, content: string, timestampMs: number, extra?: Partial<StoredEntry>) => {
      const run = persistChain.catch(() => undefined).then(async () => {
        await append(agentId, [{ provider, role: "assistant", content, id, timestampMs, ...extra }]);
        clearStreaming(id);
        lastSettled = { id, content, timestampMs };
        emitAssistant(content, false, id, timestampMs);
      });
      persistChain = run.catch((error) => {
        persistFailed = error;
        log(`persist-error ${error instanceof Error ? error.message : String(error)}`);
      });
      return run;
    };
    const settleStep = () => {
      const usedTool = stepUsedTool;
      const snapshot = visibleText;
      stepUsedTool = false;
      finishedSteps += 1;
      if (snapshot.trim().length === 0) {
        if (assistantStreamStarted) emitAssistant("", false);
        clearStreaming(assistantId);
        return;
      }
      if (usedTool) {
        log(`discard-narration ${snapshot.replaceAll("\n", " ").slice(0, 200)}`);
        visibleText = "";
        if (assistantStreamStarted) emitAssistant("", false);
        clearStreaming(assistantId);
        return;
      }
      const id = assistantId;
      const timestampMs = assistantTimestampMs;
      visibleText = "";
      advanceAssistantSlot();
      void persistThenEmit(id, snapshot, timestampMs);
    };
    const emitStreaming = (content: string) => {
      rememberStreaming(content);
      const clock = Date.now();
      if (lastStreamEmitAt !== 0 && clock - lastStreamEmitAt < ROUTED_STREAM_EMIT_THROTTLE_MS) return;
      lastStreamEmitAt = clock;
      emitAssistant(content, true);
    };
    const onTextDelta = (delta: string) => {
      visibleText += delta;
      attemptHadProgress = true;
      turnActivity.reveal({ composing: false });
      emitStreaming(visibleText);
    };
    const onProgress = (line: string) => {
      const tool = /^Using (.+)…$/u.exec(line)?.[1] ?? "tool";
      turnActivity.reveal({ composing: false, activity: { kind: "tool", tool, callId: "progress" } });
      const content = visibleText.length === 0 ? line : `${visibleText}\n\n${line}`;
      rememberStreaming(content);
      lastStreamEmitAt = Date.now();
      emitAssistant(content, true);
    };
    let turnAbort: AbortSignal | undefined;
    let screenshotStreak = 0;
    let boxHandedOff = false;
    const executeRoutedTool = async (definition: Record<string, any>, toolArgs: unknown, toolCallId: string) => {
      if (turnAbort?.aborted) {
        throw turnAbort.reason instanceof Error ? turnAbort.reason : new Error("The routed request timed out.");
      }
      attemptHadProgress = true;
      stepUsedTool = true;
      const started = Date.now();
      const name = typeof definition.name === "string" ? definition.name : "(unnamed)";
      const action = routedComputerActionName(toolArgs);
      turnActivity.reveal({
        composing: false,
        activity: { kind: "tool", tool: name, callId: toolCallId, ...(action == null ? {} : { detail: action }) },
      });
      log(`tool-start ${name} ${toolCallId}${action == null ? "" : ` ${action}`}`);
      if (name === ROUTED_BOX_CHROME_TOOL_NAME && shouldSkipRoutedBoxChromeReload(routedBoxChromeUrl(toolArgs), chromeOpenByAgent.has(agentId))) {
        log("box-chrome-skip already-open");
        return routedComputerMcpResult({ text: routedBoxChromeAlreadyOpenMessage() });
      }
      if (isRoutedComputerTool(definition) && boxHandedOff) {
        log("tool-stop box-handoff");
        return routedComputerMcpResult({ text: routedComputerBlockedByHandoffMessage(), isError: true });
      }
      if (isRoutedComputerTool(definition)) {
        screenshotStreak = nextComputerScreenshotStreak(screenshotStreak, toolArgs);
        if (screenshotStreak >= ROUTED_COMPUTER_SCREENSHOT_LOOP_LIMIT) {
          log(`tool-stop screenshot-loop ${screenshotStreak}`);
          return routedComputerMcpResult({ text: computerScreenshotLoopMessage(), isError: true });
        }
      } else {
        screenshotStreak = 0;
      }
      try {
        const result = await options.dispatchRemote(
          isRoutedComputerTool(definition) ? "executeRoutedComputerTool" : "executeRoutedMcpTool",
          {
            providerIdentifier: definition.providerIdentifier,
            name: definition.name,
            toolName: definition.toolName,
            args: toolArgs ?? {},
            toolCallId,
            agentId,
          },
        );
        const handoff = routedBoxHelpHandoff(result);
        if (handoff != null) {
          boxHandedOff = true;
          const handoffId = `t${turn}s1`;
          const handoffEntry = {
            kind: "send-message",
            id: handoffId,
            message: { type: "text", content: handoff.instruction },
            boxRequestId: handoff.requestId,
            boxInstruction: handoff.instruction,
            timestampMs: now(),
          };
          await append(agentId, [{
            provider,
            role: "assistant",
            content: handoff.instruction,
            id: handoffId,
            boxRequestId: handoff.requestId,
            boxInstruction: handoff.instruction,
            timestampMs: now(),
          }]);
          emitTranscript(agentId, "appended", handoffEntry);
          log(`box-handoff ${handoff.requestId}`);
        }
        if (name === ROUTED_BOX_CHROME_TOOL_NAME) chromeOpenByAgent.add(agentId);
        log(`tool-finish ${name} ${Date.now() - started}ms`);
        return result;
      } catch (error) {
        log(`tool-error ${name} ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    };
    const runProviderText = options.runProviderText ?? runRoutedProviderText;
    log("turn-start");
    try {
      const listedTools = await listRoutedTools();
      const hasComputer = routedToolsIncludeComputer(listedTools);
      if (hasComputer) {
        const url = extractRoutedBrowserUrl(prompt);
        if (url != null && shouldSkipRoutedBoxChromeReload(url, chromeOpenByAgent.has(agentId))) {
          log("box-chrome-auto-skip already-open");
        } else if (url != null) {
          log(`box-chrome-auto ${url}`);
          turnActivity.reveal({ composing: false, activity: { kind: "tool", tool: ROUTED_BOX_CHROME_TOOL_NAME, callId: `box-chrome-auto-t${turn}` } });
          try {
            await options.dispatchRemote("executeRoutedComputerTool", {
              name: ROUTED_BOX_CHROME_TOOL_NAME,
              toolName: ROUTED_BOX_CHROME_TOOL_NAME,
              args: { url },
              toolCallId: `box-chrome-auto-t${turn}`,
              agentId,
            });
            chromeOpenByAgent.add(agentId);
          } catch (error) {
            log(`box-chrome-auto-error ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      const timeoutMs = hasComputer ? ROUTED_COMPUTER_INFERENCE_TURN_TIMEOUT_MS : ROUTED_INFERENCE_TURN_TIMEOUT_MS;
      const maxSteps = hasComputer ? ROUTED_COMPUTER_MAX_STEPS : ROUTED_PLUGIN_MAX_STEPS;
      const abortSignal = AbortSignal.timeout(timeoutMs);
      turnAbort = abortSignal;
      const session: { bridge: { readonly url: string; close(): Promise<void> } | null } = { bridge: null };
      let content = "";
      const retryBackoffMs = options.retryBackoffMs ?? ROUTED_TURN_RETRY_BACKOFF_MS;
      try {
        session.bridge = provider === "claude-code" ? await createRoutedMcpBridge({
          listTools: listRoutedTools,
          callTool: tool => executeRoutedTool(tool, tool.args, tool.toolCallId),
        }) : null;
        const tools = session.bridge == null ? listedTools as Record<string, any>[] : undefined;
        const runOnce = async () => runProviderText(provider, messages, session.bridge == null ? {
          ...(tools === undefined ? {} : { tools }),
          executeTool: async (definition, toolArgs, toolCallId) => await executeRoutedTool(definition, toolArgs, toolCallId),
          onTextDelta,
          onProgress,
          onStreamEvent: event => {
            log(`stream ${event.type}${event.toolName == null ? "" : ` ${event.toolName}`} ${event.elapsedMs}ms`);
            if (event.type === "step-finish") settleStep();
          },
          abortSignal,
          maxSteps,
        } : { mcpServerUrl: session.bridge.url, onTextDelta, onProgress, abortSignal, maxSteps });
        let retries = 0;
        for (;;) {
          attemptHadProgress = false;
          stepUsedTool = false;
          finishedSteps = 0;
          visibleText = "";
          lastStreamEmitAt = 0;
          persistFailed = undefined;
          clearStreaming();
          try {
            content = await runOnce();
            break;
          } catch (error) {
            const overflowOnce = retries === 0 && isRoutedPromptOverflowError(error);
            const retryable = !attemptHadProgress && retries < ROUTED_TURN_MAX_RETRIES && (isRoutedTransientProviderError(error) || overflowOnce);
            if (!retryable) throw error;
            const delay = retryBackoffMs[retries] ?? retryBackoffMs.at(-1) ?? 0;
            retries += 1;
            log(`turn-retry ${retries} ${routedRouterErrorText(error)}`);
            await awaitRoutedRetryBackoff(delay, abortSignal);
          }
        }
      }
      finally { await session.bridge?.close(); }
      await persistChain.catch(() => undefined);
      if (persistFailed != null) throw persistFailed;
      if (visibleText.trim().length > 0) {
        await persistThenEmit(assistantId, visibleText, assistantTimestampMs);
      } else if (content.trim().length > 0 && assistantSlot === 0 && !assistantStreamStarted) {
        await persistThenEmit(assistantId, content, assistantTimestampMs);
      } else {
        clearStreaming();
        if (lastSettled != null) {
          emitAssistant(lastSettled.content, false, lastSettled.id, lastSettled.timestampMs);
        } else if (assistantStreamStarted) {
          emitAssistant("", false);
        }
      }
      log(`turn-finish ${visibleText.length || content.length} chars`);
    } catch (error) {
      await persistChain.catch(() => undefined);
      const content = routedSettledAssistantContent(visibleText, error);
      log(`turn-error ${content}`);
      try {
        await persistThenEmit(assistantId, content, assistantTimestampMs);
      } catch {
        emitAssistant(content, false);
      }
    }
    finally { turnActivity.stop(); }
    return { accepted: true, clientNonce, provider };
  };

  void load();
  return {
    provider(): SandInferenceProvider { return settings.getInferenceProvider(); },
    async dispatch(method: string, args: unknown): Promise<{ handled: boolean; value?: unknown }> {
      const provider = settings.getInferenceProvider();
      if (method === "reactToMessage") {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const entryId = typeof record.entryId === "string" ? record.entryId : "";
        const emoji = typeof record.emoji === "string" ? record.emoji : "";
        const updated = await toggleLocalReaction(agentId, entryId, emoji);
        if (updated != null) {
          emitTranscript(agentId, "updated", updated);
          return { handled: true, value: undefined };
        }
      }
      if (provider !== "cursor" && method === "listAgents") {
        const remote = await options.dispatchRemote(method, args);
        const local = await load();
        return { handled: true, value: overlayRoutedRosterLastEntry(remote, local) };
      }
      if (provider !== "cursor" && ["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"].includes(method)) {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.id === "string" ? record.id : "";
        const [remote, local] = await Promise.all([options.dispatchRemote(method, args), load()]);
        const result = asRecord(remote);
        if (result == null || !Array.isArray(result.entries) || agentId.length === 0) return { handled: true, value: remote };
        const persisted = (local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry);
        const combined = [...result.entries, ...persisted];
        const live = streamingByAgent.get(agentId);
        if (live != null && live.content.trim().length > 0 && !combined.some(entry => asRecord(entry)?.id === live.id)) {
          combined.push({
            kind: "send-message",
            id: live.id,
            message: { type: "text", content: live.content },
            streaming: true,
            timestampMs: live.timestampMs,
          });
        }
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
        return { handled: true, value: { ...result, entries: combined.slice(-limit) } };
      }
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const clientNonce = typeof record.clientNonce === "string" ? record.clientNonce : randomUUID();
      const previous = queues.get(agentId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => execute(provider, { ...record, clientNonce })).catch(async (error) => {
        const timestampMs = now();
        const content = routedRouterErrorText(error);
        if (agentId.length > 0) {
          const id = `err-${randomUUID()}`;
          await append(agentId, [{ provider, role: "assistant", content, id, timestampMs }]);
          emitTranscript(agentId, "appended", { kind: "send-message", id, message: { type: "text", content }, timestampMs });
        }
      });
      const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
      queues.set(agentId, queued);
      void queued.catch(() => undefined);
      return { handled: true, value: { accepted: true, clientNonce, provider } };
    },
    overlayAgents,
  };
}
