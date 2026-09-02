import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import { appendRoutedInferenceLog, isRoutedPromptOverflowError, isRoutedTransientProviderError, routedRouterErrorText, routedSettledAssistantContent } from "../shared/routed-inference-log.js";
import { ROUTED_TURN_STOPPED_MESSAGE, RoutedTurnAbortError, isRoutedTurnAbortError } from "../shared/routed-turn-abort.js";
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
  shouldSkipRoutedBoxChromeReload,
  turnNeedsRoutedComputer,
} from "../shared/routed-computer-tools.js";
import {
  isRoutedSendToAgentTool,
  listRoutedSendToAgentToolDefinitions,
  parseRoutedSendToAgentArgs,
  routedSendToAgentDeliveredAck,
  routedSendToAgentEmptyAck,
  routedSendToAgentGroupAck,
  routedSendToAgentMissingAck,
  routedSendToAgentSelfAck,
  routedSendToAgentSharedRoomAck,
  routedTeammatesOf,
  type RoutedAgentImage,
} from "../shared/routed-agent-tools.js";
import { buildAgentInboundWakePrompt, renderAgentDirectorySystemPrompt } from "../host/agents/agent-messaging.js";
import type { SandInferenceProvider } from "../shared/inference-router.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { createRoutedMcpBridge } from "./routed-mcp-bridge.js";
import { COMPOSIO_TOOLS_MISSING_MESSAGE, promptLooksLikeComposioPluginUse } from "../shared/node/composio-mcp.js";

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

type AgentRef = { readonly id: string; readonly name: string; readonly kind?: string };
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
  readonly fromAgent?: AgentRef;
  readonly toAgent?: AgentRef;
  readonly images?: readonly RoutedAgentImage[];
};
type Store = { readonly schemaVersion: 2; readonly agents: Readonly<Record<string, readonly StoredEntry[]>> };

const EMPTY_STORE: Store = { schemaVersion: 2, agents: {} };

export function coalesceRoutedProviderMessages(entries: readonly { readonly role: string; readonly content: string; readonly fromAgent?: unknown }[]): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const entry of entries) {
    if (entry.fromAgent != null) continue;
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

function parseAgentRef(value: unknown): AgentRef | null {
  const row = asRecord(value);
  if (row == null || typeof row.id !== "string" || row.id.length === 0 || typeof row.name !== "string") return null;
  return { id: row.id, name: row.name, ...(typeof row.kind === "string" ? { kind: row.kind } : {}) };
}

function parseStoredImages(value: unknown): readonly RoutedAgentImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images: RoutedAgentImage[] = [];
  for (const raw of value) {
    const row = asRecord(raw);
    if (row == null) return undefined;
    const url = typeof row.url === "string" ? row.url : "";
    if (url.length === 0) return undefined;
    const alt = typeof row.alt === "string" && row.alt.length > 0 ? row.alt : undefined;
    images.push({ url, ...(alt == null ? {} : { alt }) });
  }
  return images;
}

export function parseRoutedSendPromptAttachments(args: Record<string, unknown>): { paths: string[]; names: string[] } {
  if (Array.isArray(args.attachmentPaths)) {
    const paths = args.attachmentPaths.filter((path): path is string => typeof path === "string" && path.length > 0);
    const rawNames = Array.isArray(args.attachmentNames) ? args.attachmentNames : [];
    const names = paths.map((path, index) => {
      const name = rawNames[index];
      return typeof name === "string" && name.length > 0 ? name : path.split("/").pop() ?? `attachment-${index + 1}`;
    });
    return { paths, names };
  }
  if (!Array.isArray(args.attachments)) return { paths: [], names: [] };
  const paths: string[] = [];
  const names: string[] = [];
  for (const raw of args.attachments) {
    const row = asRecord(raw);
    if (row == null) continue;
    const path = typeof row.path === "string" ? row.path : "";
    if (path.length === 0) continue;
    const name = typeof row.filename === "string" && row.filename.length > 0
      ? row.filename
      : typeof row.name === "string" && row.name.length > 0
        ? row.name
        : path.split("/").pop() ?? `attachment-${paths.length + 1}`;
    paths.push(path);
    names.push(name);
  }
  return { paths, names };
}

async function materializeRoutedSendPromptAttachments(
  dispatchRemote: (method: string, args: unknown) => Promise<unknown>,
  agentId: string,
  paths: readonly string[],
  names: readonly string[],
): Promise<{ promptSuffix: string; images: readonly RoutedAgentImage[]; videoAttachments: readonly { readonly path: string; readonly name: string }[] }> {
  const blocks: string[] = [];
  const images: RoutedAgentImage[] = [];
  const videoAttachments: Array<{ readonly path: string; readonly name: string }> = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]!;
    const name = names[index] ?? path.split("/").pop() ?? `attachment-${index + 1}`;
    const chunkResult = await dispatchRemote("readAttachmentChunk", {
      path,
      agentId,
      offset: 0,
      length: 1,
      videoPlayback: true,
    });
    const chunkRecord = asRecord(chunkResult);
    const mime = typeof chunkRecord?.mime === "string" ? chunkRecord.mime : "";
    if (mime.startsWith("video/")) {
      videoAttachments.push({ path, name });
      blocks.push(`Attached video "${name}" at ${path}.`);
      continue;
    }
    const textResult = await dispatchRemote("readAttachmentText", { path, agentId });
    const textRecord = asRecord(textResult);
    if (textRecord?.kind === "text" && typeof textRecord.text === "string") {
      blocks.push(`Attached file "${name}":\n${textRecord.text}`);
      continue;
    }
    const imageResult = await dispatchRemote("readAttachmentImage", { path });
    const imageRecord = asRecord(imageResult);
    if (typeof imageRecord?.dataUrl === "string" && imageRecord.dataUrl.length > 0) {
      images.push({ url: imageRecord.dataUrl, alt: name });
      blocks.push(`Attached image "${name}".`);
    }
  }
  return {
    promptSuffix: blocks.length === 0 ? "" : `\n\n${blocks.join("\n\n")}`,
    images,
    videoAttachments,
  };
}

async function reviewRoutedVideoAttachments(
  dispatchRemote: (method: string, args: unknown) => Promise<unknown>,
  agentId: string,
  videos: readonly { readonly path: string; readonly name: string }[],
): Promise<string> {
  const summaries: string[] = [];
  for (const video of videos) {
    const result = await dispatchRemote("reviewRoutedVideoAttachment", {
      id: agentId,
      agentId,
      path: video.path,
      name: video.name,
    });
    const record = asRecord(result);
    const summary = typeof record?.summary === "string" ? record.summary.trim() : "";
    if (summary.length > 0) summaries.push(`Video review for "${video.name}":\n${summary}`);
  }
  return summaries.length === 0 ? "" : `\n\n${summaries.join("\n\n")}`;
}

function joinRoutedSystemExtra(...parts: readonly (string | undefined)[]): string {
  return parts
    .map(part => part?.trim() ?? "")
    .filter(part => part.length > 0)
    .join("\n\n");
}

async function loadRoutedSystemExtra(
  dispatchRemote: (method: string, args: unknown) => Promise<unknown>,
  agentId: string,
  rosterExtra: string,
): Promise<string> {
  const remote = await dispatchRemote("getRoutedSystemPromptExtra", { id: agentId, agentId });
  const record = asRecord(remote);
  const liveExtra = typeof record?.extra === "string" ? record.extra : "";
  return joinRoutedSystemExtra(rosterExtra, liveExtra);
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
      const fromAgent = row.fromAgent === undefined ? undefined : parseAgentRef(row.fromAgent);
      if (row.fromAgent !== undefined && fromAgent == null) continue;
      const toAgent = row.toAgent === undefined ? undefined : parseAgentRef(row.toAgent);
      if (row.toAgent !== undefined && toAgent == null) continue;
      const images = row.images === undefined ? undefined : parseStoredImages(row.images);
      if (row.images !== undefined && images == null) continue;
      entries.push({
        ...(row as unknown as StoredEntry),
        ...(fromAgent == null ? {} : { fromAgent }),
        ...(toAgent == null ? {} : { toAgent }),
        ...(images == null ? {} : { images }),
      });
    }
    agents[agentId] = entries.slice(-200);
  }
  return { schemaVersion: 2, agents };
}

export function overlayCoordinatorRosterEvent(
  payload: unknown,
  store: { readonly agents: Readonly<Record<string, readonly { readonly id: string; readonly content: string; readonly timestampMs: number }[]>> },
  stampAgents: (agents: unknown) => unknown = (agents) => agents,
): unknown {
  const record = asRecord(payload);
  if (record == null) return payload;
  if (Array.isArray(record.agents)) {
    return { ...record, agents: stampAgents(overlayRoutedRosterLastEntry(record.agents, store)) };
  }
  if (asRecord(record.agent) != null) {
    const overlaid = stampAgents(overlayRoutedRosterLastEntry([record.agent], store));
    const agent = Array.isArray(overlaid) ? overlaid[0] : record.agent;
    return { ...record, agent };
  }
  return payload;
}

export function overlayRoutedRosterLastEntry(
  agents: unknown,
  store: { readonly agents: Readonly<Record<string, readonly { readonly id: string; readonly content: string; readonly timestampMs: number }[]>> },
): unknown {
  if (!Array.isArray(agents)) return agents;
  return agents.map(raw => {
    const row = asRecord(raw);
    if (row == null) return raw;
    if (row.isGroup === true) return raw;
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
    };
  });
}

export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  return entry.role === "user"
    ? {
        kind: "message",
        id: entry.id,
        role: "user",
        content: entry.content,
        ...(entry.richText === undefined ? {} : { richText: entry.richText }),
        isStreaming: false,
        timestampMs: entry.timestampMs,
        ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }),
        ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }),
        ...(entry.fromAgent == null ? {} : { fromAgent: entry.fromAgent }),
        ...(entry.images == null ? {} : { images: entry.images }),
      }
    : {
        kind: "send-message",
        id: entry.id,
        message: { type: "text", content: entry.content },
        timestampMs: entry.timestampMs,
        ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }),
        ...(entry.boxRequestId == null ? {} : { boxRequestId: entry.boxRequestId, boxInstruction: entry.boxInstruction ?? entry.content }),
        ...(entry.toAgent == null ? {} : { toAgent: entry.toAgent }),
        ...(entry.images == null ? {} : { images: entry.images }),
      };
}

function routedLogLine(dataDir: string, provider: string, agentId: string, message: string, postEvent: (family: string, payload: unknown) => void): void {
  const line = `${provider} ${agentId} ${message}`;
  appendRoutedInferenceLog(dataDir, line);
  postEvent("routed-log", { line, agentId, provider });
}

function routedPromptTraceEnabled(): boolean {
  return (process.env.GROK_BOT_ROUTED_TRACE ?? "").toLowerCase().includes("prompt");
}

export function createCoordinatorInferenceRouter(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  readonly now?: () => number;
  readonly composingDelayMs?: number;
  readonly retryBackoffMs?: readonly number[];
  readonly turnTimeoutMs?: number;
  readonly runProviderText?: typeof runRoutedProviderText;
}) {
  const settings = new SandSettingsStore(join(options.dataDir, "settings.json"));
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<unknown>>();
  const streamingByAgent = new Map<string, { readonly id: string; readonly content: string; readonly timestampMs: number }>();
  const chromeOpenByAgent = new Set<string>();
  const turnControllers = new Map<string, AbortController>();
  const turnActivities = new Map<string, { stop(): void }>();
  const queuedTurnGenerations = new Map<string, number>();

  const abortAgentTurn = (agentId: string, kind: "stop" | "supersede"): boolean => {
    const controller = turnControllers.get(agentId);
    if (controller == null || controller.signal.aborted) return false;
    controller.abort(new RoutedTurnAbortError(kind));
    turnActivities.get(agentId)?.stop();
    if (kind === "supersede") queuedTurnGenerations.set(agentId, (queuedTurnGenerations.get(agentId) ?? 0) + 1);
    return true;
  };
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
  const stampLiveTurnState = (agents: unknown): unknown => {
    if (!Array.isArray(agents)) return agents;
    return agents.map(raw => {
      const row = asRecord(raw);
      if (row == null) return raw;
      const id = typeof row.id === "string" ? row.id : "";
      const controller = turnControllers.get(id);
      const isRunning = controller != null && !controller.signal.aborted;
      if (isRunning) return { ...row, isRunning: true, isRunningTurn: true };
      return { ...row, isRunning: false, isRunningTurn: false, isComposingMessage: false, currentActivity: undefined };
    });
  };
  const overlayAgents = (payload: unknown): unknown => overlayCoordinatorRosterEvent(payload, snapshot, stampLiveTurnState);
  const append = async (agentId: string, entries: readonly StoredEntry[]): Promise<Store> => withStore(async () => {
    const current = await load();
    const next: Store = { schemaVersion: 2, agents: { ...current.agents, [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-200) } };
    await persist(next);
    return next;
  });
  const dropAgents = async (agentIds: readonly string[]): Promise<void> => withStore(async () => {
    const ids = agentIds.filter(id => id.length > 0);
    if (ids.length === 0) return;
    for (const id of ids) {
      abortAgentTurn(id, "stop");
      streamingByAgent.delete(id);
      chromeOpenByAgent.delete(id);
      turnActivities.delete(id);
      queues.delete(id);
      queuedTurnGenerations.set(id, (queuedTurnGenerations.get(id) ?? 0) + 1);
    }
    const current = await load();
    const agents = { ...current.agents };
    let changed = false;
    for (const id of ids) {
      if (id in agents) {
        delete agents[id];
        changed = true;
      }
    }
    if (changed) await persist({ schemaVersion: 2, agents });
  });
  const deletedAgentIdsFromArgs = (method: string, args: unknown): string[] => {
    const record = asRecord(args) ?? {};
    if (method === "deleteAgent") return typeof record.id === "string" ? [record.id] : [];
    if (!Array.isArray(record.ids)) return [];
    return record.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  };
  const emitTranscript = (agentId: string, type: "appended" | "updated", entry: Record<string, unknown>) => options.postEvent("transcript", { type, entry, agentId });
  type RoutedActivity = { kind: "thinking" } | { kind: "tool"; tool: string; callId: string; detail?: string };
  type TurnActivity = { stop(): void; reveal(next: { composing?: boolean; activity?: RoutedActivity }): void };
  const idleTurnActivity = (): TurnActivity => ({ stop() {}, reveal() {} });
  const beginActivity = async (agentId: string): Promise<TurnActivity> => {
    try {
      let remote = await options.dispatchRemote("listAgents", {});
      if (!Array.isArray(remote)) return idleTurnActivity();
      let live = true;
      const surface: { composing: boolean; activity: RoutedActivity } = { composing: true, activity: { kind: "thinking" } };
      const routedActivityEquals = (a: RoutedActivity, b: RoutedActivity): boolean => {
        if (a.kind !== b.kind) return false;
        if (a.kind !== "tool" || b.kind !== "tool") return true;
        return a.tool === b.tool && a.callId === b.callId && (a.detail ?? "") === (b.detail ?? "");
      };

      const project = (isRunning: boolean, roster: unknown[]) => overlayRoutedRosterLastEntry(roster.map(raw => {
        const row = asRecord(raw);
        if (row?.id !== agentId) return raw;
        return { ...row, isRunning, isRunningTurn: isRunning, isComposingMessage: isRunning && surface.composing, isRetrying: false, ...(isRunning ? { currentActivity: surface.activity } : { currentActivity: undefined }) };
      }), snapshot);
      const publishRunning = () => {
        if (!live) return;
        const controller = turnControllers.get(agentId);
        if (controller?.signal.aborted) return;
        options.postEvent("agents", { activeAgentId: agentId, agents: project(true, Array.isArray(remote) ? remote : []) });
      };
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
          if (!live) return;
          if (next.composing !== undefined && next.composing !== surface.composing) {
            surface.composing = next.composing;
            publishRunning();
            return;
          }
          if (next.activity !== undefined && !routedActivityEquals(surface.activity, next.activity)) {
            surface.activity = next.activity;
            publishRunning();
          }
        },
        stop() {
          if (!live) return;
          live = false;
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
    const hidden = args.hidden === true;
    const { paths: attachmentPaths, names: attachmentNames } = parseRoutedSendPromptAttachments(args);
    if (agentId.length === 0 || (prompt.length === 0 && attachmentPaths.length === 0)) {
      throw new Error("Local inference routing requires an agentId and prompt");
    }
    const timestampMs = now();
    const attachmentMaterial = attachmentPaths.length === 0
      ? { promptSuffix: "", images: [] as readonly RoutedAgentImage[], videoAttachments: [] as readonly { readonly path: string; readonly name: string }[] }
      : await materializeRoutedSendPromptAttachments(options.dispatchRemote, agentId, attachmentPaths, attachmentNames);
    const videoReviewSuffix = attachmentMaterial.videoAttachments.length === 0
      ? ""
      : await reviewRoutedVideoAttachments(options.dispatchRemote, agentId, attachmentMaterial.videoAttachments);
    const effectivePrompt = `${prompt}${attachmentMaterial.promptSuffix}${videoReviewSuffix}`;
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
    const chromeAlreadyOpen = chromeOpenByAgent.has(agentId);
    let withUser = beforeUser;
    if (!hidden) {
      for (let attachmentIndex = 0; attachmentIndex < attachmentPaths.length; attachmentIndex += 1) {
        const attachmentEntry = {
          kind: "user-attachment",
          id: `t${turn}a${attachmentIndex}`,
          file_path: attachmentPaths[attachmentIndex],
          file_name: attachmentNames[attachmentIndex] ?? attachmentPaths[attachmentIndex]!.split("/").pop(),
          isStreaming: false,
          timestampMs,
          ...(clientNonce.length === 0 ? {} : { clientNonce }),
        };
        emitTranscript(agentId, "appended", attachmentEntry);
      }
      const userEntry = {
        kind: "message",
        id: `t${turn}u`,
        role: "user",
        content: effectivePrompt,
        ...(richText === undefined ? {} : { richText }),
        isStreaming: false,
        timestampMs,
        clientNonce,
      };
      withUser = await append(agentId, [{
        provider,
        role: "user",
        content: effectivePrompt,
        ...(richText === undefined ? {} : { richText }),
        ...(attachmentMaterial.images.length === 0 ? {} : { images: attachmentMaterial.images }),
        id: userEntry.id,
        clientNonce,
        timestampMs,
      }]);
      emitTranscript(agentId, "appended", userEntry);
    }
    const userAbort = new AbortController();
    turnControllers.set(agentId, userAbort);
    const turnActivity = await beginActivity(agentId);
    turnActivities.set(agentId, turnActivity);
    if (userAbort.signal.aborted) turnActivity.stop();
    let turnAbort: AbortSignal | undefined = userAbort.signal;
    const log = (message: string) => routedLogLine(options.dataDir, provider, agentId, message, options.postEvent);
    try {
      await awaitRoutedRetryBackoff(options.composingDelayMs ?? 1_200, turnAbort);
    } catch (error) {
      if (turnControllers.get(agentId) === userAbort) turnControllers.delete(agentId);
      if (turnActivities.get(agentId) === turnActivity) turnActivities.delete(agentId);
      turnActivity.stop();
      if (isRoutedTurnAbortError(error) && error.kind === "supersede") {
        log("turn-supersede");
        return { accepted: true, clientNonce, provider };
      }
      const content = isRoutedTurnAbortError(error) && error.kind === "stop"
        ? ROUTED_TURN_STOPPED_MESSAGE
        : routedSettledAssistantContent("", error);
      log(isRoutedTurnAbortError(error) ? `turn-stop ${content}` : `turn-error ${content}`);
      const id = `t${turn}s0`;
      await append(agentId, [{ provider, role: "assistant", content, id, timestampMs: now() }]);
      emitTranscript(agentId, "appended", { kind: "send-message", id, message: { type: "text", content }, timestampMs: now() });
      return { accepted: true, clientNonce, provider };
    }
    const messages = coalesceRoutedProviderMessages(withUser.agents[agentId] ?? []);
    if (hidden) messages.push({ role: "user", content: effectivePrompt });
    if (routedPromptTraceEnabled()) {
      const base = messages.length - Math.min(4, messages.length);
      for (const [index, message] of messages.slice(-4).entries()) {
        const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        log(`prompt-part ${base + index}/${messages.length} ${message.role} ${text.replaceAll("\n", " ").slice(0, 240)}`);
      }
    }
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
    const drive = turnNeedsRoutedComputer(effectivePrompt, chromeAlreadyOpen);
    const listRoutedTools = async (): Promise<unknown[]> => {
      const native = [...listRoutedSendToAgentToolDefinitions()];
      const plugins = await options.dispatchRemote("listRoutedMcpTools", {});
      const pluginList = Array.isArray(plugins) ? plugins : [];
      if (!drive) return mergeRoutedToolLists(native, pluginList);
      const computer = await options.dispatchRemote("listRoutedComputerTools", {});
      return mergeRoutedToolLists(native, mergeRoutedToolLists(Array.isArray(computer) ? computer : [], pluginList));
    };
    let visibleText = "";
    let persistChain = Promise.resolve();
    let persistFailed: unknown;
    let stepUsedTool = false;
    let finishedSteps = 0;
    let toolsCompleted = 0;
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
      const alreadyShown = assistantStreamStarted;
      stepUsedTool = false;
      finishedSteps += 1;
      if (usedTool) {
        if (snapshot.trim().length > 0) {
          log(`discard-narration ${snapshot.replaceAll("\n", " ").slice(0, 200)}`);
          visibleText = "";
        }
        toolsCompleted += 1;
        if (alreadyShown) emitAssistant("", false);
        clearStreaming(assistantId);
        return;
      }
      if (snapshot.trim().length === 0) {
        if (alreadyShown) emitAssistant("", false);
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
      if (toolsCompleted > 0) emitStreaming(visibleText);
    };
    const onProgress = (line: string) => {
      const tool = /^Using (.+)…$/u.exec(line)?.[1] ?? "tool";
      turnActivity.reveal({ composing: false, activity: { kind: "tool", tool, callId: "progress" } });
    };
    let screenshotStreak = 0;
    let boxHandedOff = false;
    const loadRoster = async () => {
      const remote = await options.dispatchRemote("listAgents", {});
      if (!Array.isArray(remote)) return [];
      const roster: Array<{ id: string; name?: unknown; description?: unknown; isGroup?: unknown; remoteRoom?: unknown }> = [];
      for (const row of remote) {
        const record = asRecord(row);
        if (record == null || typeof record.id !== "string" || record.id.length === 0) continue;
        roster.push(record as { id: string; name?: unknown; description?: unknown; isGroup?: unknown; remoteRoom?: unknown });
      }
      return roster;
    };
    const deliverToAgent = async (
      targetId: string,
      message: string,
      images: readonly RoutedAgentImage[],
      priority: boolean,
    ): Promise<string> => {
      if (message.length === 0) return routedSendToAgentEmptyAck();
      if (targetId === agentId) return routedSendToAgentSelfAck();
      const roster = await loadRoster();
      const target = roster.find(agent => agent.id === targetId);
      if (target == null) return routedSendToAgentMissingAck(targetId);
      if (target.isGroup === true) return routedSendToAgentGroupAck();
      if (target.remoteRoom != null) return routedSendToAgentSharedRoomAck();
      const sender = roster.find(agent => agent.id === agentId);
      const senderName = typeof sender?.name === "string" && sender.name.trim().length > 0 ? sender.name.trim() : "An agent";
      const targetName = typeof target.name === "string" && target.name.trim().length > 0 ? target.name.trim() : targetId;
      const sentAt = now();
      const outboundId = `peer-out-${randomUUID()}`;
      const inboundId = `peer-in-${randomUUID()}`;
      const toAgent = { id: targetId, name: targetName, kind: "agent" as const };
      const fromAgent = { id: agentId, name: senderName };
      await append(agentId, [{
        provider,
        role: "assistant",
        content: message,
        id: outboundId,
        timestampMs: sentAt,
        toAgent,
        ...(images.length === 0 ? {} : { images }),
      }]);
      emitTranscript(agentId, "appended", {
        kind: "send-message",
        id: outboundId,
        message: { type: "text", content: message },
        toAgent,
        timestampMs: sentAt,
        ...(images.length === 0 ? {} : { images }),
      });
      await append(targetId, [{
        provider,
        role: "user",
        content: message,
        id: inboundId,
        timestampMs: sentAt,
        fromAgent,
        ...(images.length === 0 ? {} : { images }),
      }]);
      emitTranscript(targetId, "appended", {
        kind: "message",
        id: inboundId,
        role: "user",
        content: message,
        fromAgent,
        isStreaming: false,
        timestampMs: sentAt,
        ...(images.length === 0 ? {} : { images }),
      });
      const wake = buildAgentInboundWakePrompt({
        from: { id: agentId, name: senderName },
        text: message,
        ...(images.length === 0 ? {} : { images }),
        ...(priority ? { priority: true } : {}),
      });
      if (priority) abortAgentTurn(targetId, "supersede");
      enqueueTurn(targetId, provider, { agentId: targetId, prompt: wake, hidden: true, clientNonce: randomUUID() });
      log(`send-to-agent ${targetId}${priority ? " priority" : ""}`);
      return routedSendToAgentDeliveredAck(targetName, priority);
    };
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
      if (isRoutedSendToAgentTool(definition)) {
        const parsed = parseRoutedSendToAgentArgs(toolArgs);
        if (parsed == null) return routedComputerMcpResult({ text: routedSendToAgentMissingAck(""), isError: true });
        const ack = parsed.targetId === agentId
          ? routedSendToAgentSelfAck()
          : await deliverToAgent(parsed.targetId, parsed.message, parsed.images, parsed.priority);
        log(`tool-finish ${name} ${Date.now() - started}ms`);
        return routedComputerMcpResult({ text: ack });
      }
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
    const slot = drive ? "drive" as const : "think" as const;
    const promptChars = messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
    log(`turn-start ${slot} ${messages.length} msgs ${promptChars} chars`);
    try {
      const listedTools = await listRoutedTools();
      const pluginTools = listedTools.some((tool) => {
        const row = asRecord(tool) ?? {};
        return !isRoutedComputerTool(row) && !isRoutedSendToAgentTool(row);
      });
      if (!hidden && !pluginTools && !drive && promptLooksLikeComposioPluginUse(effectivePrompt)) {
        await persistThenEmit(assistantId, COMPOSIO_TOOLS_MISSING_MESSAGE, assistantTimestampMs);
        log("turn-finish composio-tools-missing");
        return { accepted: true, clientNonce, provider };
      }
      const roster = await loadRoster();
      const systemExtra = await loadRoutedSystemExtra(
        options.dispatchRemote,
        agentId,
        renderAgentDirectorySystemPrompt(routedTeammatesOf(roster, agentId)),
      );
      if (drive) {
        const url = extractRoutedBrowserUrl(effectivePrompt);
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
      const timeoutMs = options.turnTimeoutMs
        ?? (drive ? ROUTED_COMPUTER_INFERENCE_TURN_TIMEOUT_MS : ROUTED_INFERENCE_TURN_TIMEOUT_MS);
      log(`turn-deadline ${Math.round(timeoutMs / 100) / 10}s`);
      const maxSteps = drive ? ROUTED_COMPUTER_MAX_STEPS : ROUTED_PLUGIN_MAX_STEPS;
      const abortSignal = AbortSignal.any([userAbort.signal, AbortSignal.timeout(timeoutMs)]);
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
            if (event.type !== "text-delta" && event.type !== "reasoning-delta") {
              log(`stream ${event.type}${event.toolName == null ? "" : ` ${event.toolName}`} ${event.elapsedMs}ms`);
            }
            if (event.type === "step-finish") settleStep();
          },
          abortSignal,
          maxSteps,
          slot,
          pluginTools,
          systemExtra,
        } : { mcpServerUrl: session.bridge.url, onTextDelta, onProgress, abortSignal, maxSteps, slot, pluginTools, systemExtra });
        let retries = 0;
        for (;;) {
          attemptHadProgress = false;
          stepUsedTool = false;
          finishedSteps = 0;
          toolsCompleted = 0;
          visibleText = "";
          lastStreamEmitAt = 0;
          persistFailed = undefined;
          clearStreaming();
          try {
            content = await runOnce();
            break;
          } catch (error) {
            const overflowOnce = retries === 0 && isRoutedPromptOverflowError(error);
            const retryable = !attemptHadProgress && retries < ROUTED_TURN_MAX_RETRIES && !isRoutedTurnAbortError(error) && (isRoutedTransientProviderError(error) || overflowOnce);
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
      } else if (content.trim().length > 0 && assistantSlot === 0 && !assistantStreamStarted && finishedSteps === 0) {
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
      const deadlineFired = turnAbort?.aborted === true && !userAbort.signal.aborted;
      if (isRoutedTurnAbortError(error) && error.kind === "supersede") {
        log("turn-supersede");
        if (assistantStreamStarted) emitAssistant("", false);
        clearStreaming();
      } else if (deadlineFired && !isRoutedTurnAbortError(error)) {
        const content = routedSettledAssistantContent(visibleText, error);
        log(`turn-timeout content ${content}`);
        try {
          await persistThenEmit(assistantId, content, assistantTimestampMs);
        } catch {
          emitAssistant(content, false);
        }
      } else {
        const content = isRoutedTurnAbortError(error) && error.kind === "stop"
          ? (visibleText.trim().length > 0 ? visibleText.trim() : ROUTED_TURN_STOPPED_MESSAGE)
          : routedSettledAssistantContent(visibleText, error);
        log(isRoutedTurnAbortError(error) ? `turn-stop ${content}` : `turn-error ${content}`);
        try {
          await persistThenEmit(assistantId, content, assistantTimestampMs);
        } catch {
          emitAssistant(content, false);
        }
      }
    }
    finally {
      if (turnControllers.get(agentId) === userAbort) turnControllers.delete(agentId);
      if (turnActivities.get(agentId) === turnActivity) turnActivities.delete(agentId);
      if (!turnActivities.has(agentId)) turnActivity.stop();
    }
    return { accepted: true, clientNonce, provider };
  };

  const enqueueTurn = (
    agentId: string,
    provider: Exclude<SandInferenceProvider, "cursor">,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const previous = queues.get(agentId) ?? Promise.resolve();
    const generation = (queuedTurnGenerations.get(agentId) ?? 0) + 1;
    queuedTurnGenerations.set(agentId, generation);
    const next = previous.catch(() => undefined).then(() => {
      if (queuedTurnGenerations.get(agentId) !== generation) return undefined;
      return execute(provider, args);
    }).catch(async (error) => {
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
    return queued;
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
        return { handled: true, value: stampLiveTurnState(overlayRoutedRosterLastEntry(remote, local)) };
      }
      if (provider !== "cursor" && ["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"].includes(method)) {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.id === "string" ? record.id : "";
        const remote = await options.dispatchRemote(method, args);
        if (agentId.length > 0) {
          const roster = await options.dispatchRemote("listAgents", {});
          if (Array.isArray(roster)) {
            const target = roster.find((row) => {
              const entry = asRecord(row);
              return entry != null && entry.id === agentId;
            });
            if (asRecord(target)?.isGroup === true) return { handled: true, value: remote };
          }
        }
        const local = await load();
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
      if (method === "stopRoutedTurn") {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        if (agentId.length === 0) return { handled: true, value: { stopped: false } };
        const stopped = abortAgentTurn(agentId, "stop");
        routedLogLine(options.dataDir, provider, agentId, `turn-abort ${stopped ? "stop" : "idle"}`, options.postEvent);
        return { handled: true, value: { stopped } };
      }
      if (method === "deleteAgent" || method === "deleteAgents") {
        const ids = deletedAgentIdsFromArgs(method, args);
        const remote = await options.dispatchRemote(method, args);
        await dropAgents(ids);
        return { handled: true, value: remote };
      }
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      if (agentId.length > 0) {
        const remote = await options.dispatchRemote("listAgents", {});
        if (Array.isArray(remote)) {
          const target = remote.find((row) => {
            const entry = asRecord(row);
            return entry != null && entry.id === agentId;
          });
          if (asRecord(target)?.isGroup === true) return { handled: false };
        }
      }
      const clientNonce = typeof record.clientNonce === "string" ? record.clientNonce : randomUUID();
      if (agentId.length > 0) abortAgentTurn(agentId, "supersede");
      enqueueTurn(agentId, provider, { ...record, clientNonce });
      return { handled: true, value: { accepted: true, clientNonce, provider } };
    },
    overlayAgents,
  };
}
