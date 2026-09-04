import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText, routedInferenceSummary } from "../host/extensions/inference/provider-session.js";
import { buildGroupMemberSystemPrompt, buildGroupTurnPrompt, GROUP_MAX_MEMBER_TURNS, GROUP_MAX_ROUNDS, isPassContent, messagesSinceMemberLastSpoke, orderRoundSpeakers, resolveResponders, type GroupMessage } from "../host/groups/group-chat.js";
import { appendRoutedInferenceLog, isRoutedPromptOverflowError, isRoutedTransientProviderError, routedRouterErrorText, routedSettledAssistantContent } from "../shared/routed-inference-log.js";
import { ROUTED_TURN_STOPPED_MESSAGE, RoutedTurnAbortError, isRoutedTurnAbortError } from "../shared/routed-turn-abort.js";
import {
  ROUTED_COMPUTER_INFERENCE_TURN_TIMEOUT_MS,
  ROUTED_COMPUTER_MAX_STEPS,
  ROUTED_COMPUTER_SCREENSHOT_LOOP_LIMIT,
  ROUTED_INFERENCE_TURN_TIMEOUT_MS,
  ROUTED_PLUGIN_MAX_STEPS,
  routedTurnTimeoutMs,
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
  buildRoutedAgentIntroductionWakePrompt,
  isRoutedAgentManagementTool,
  isRoutedSendToAgentTool,
  listRoutedAgentManagementToolDefinitions,
  listRoutedSendToAgentToolDefinitions,
  parseRoutedCreateAgentArgs,
  parseRoutedSendToAgentArgs,
  parseRoutedUpdateAgentArgs,
  routedAgentManagementFailedAck,
  routedCreateAgentAck,
  routedCreateAgentNeedsBriefAck,
  routedNewAgentIntroductionClause,
  routedSendToAgentDeliveredAck,
  routedSendToAgentEmptyAck,
  routedSendToAgentGroupAck,
  routedSendToAgentMissingAck,
  routedSendToAgentSelfAck,
  routedSendToAgentSharedRoomAck,
  routedTeammatesOf,
  routedUpdateAgentAck,
  routedUpdateAgentNeedsFieldsAck,
  routedUpdateAgentSelfAck,
  ROUTED_CREATE_AGENT_TOOL_NAME,
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
  readonly author?: AgentRef;
  readonly fromUser?: { readonly name?: string };
  readonly images?: readonly RoutedAgentImage[];
  readonly widget?: { readonly type: "auto-review-approval"; readonly approval: Record<string, unknown> };
};
type Store = { readonly schemaVersion: 2; readonly agents: Readonly<Record<string, readonly StoredEntry[]>> };

type AutomationRunRecord = {
  readonly id: string;
  readonly status: "running" | "ok" | "error";
  readonly trigger: "manual" | "schedule";
  readonly startedAt: number;
  readonly finishedAt?: number;
};

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
  if (entry.widget != null) {
    return {
      kind: "send-message",
      id: entry.id,
      message: entry.widget,
      timestampMs: entry.timestampMs,
      ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }),
    };
  }
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
        ...(entry.fromUser == null ? {} : { fromUser: entry.fromUser }),
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
        ...(entry.author == null ? {} : { author: entry.author }),
        ...(entry.images == null ? {} : { images: entry.images }),
      };
}

const ROUTED_DEBUG_LOG_LIMIT = 8;
const ROUTED_DEBUG_LOG_AGENTS = 256;
const routedDebugLog = new Map<string, { at: number; provider: string; text: string }[]>();

function noteRoutedDebugLog(agentId: string, provider: string, message: string): void {
  if (agentId.length === 0) return;
  const ring = routedDebugLog.get(agentId) ?? [];
  ring.push({ at: Date.now(), provider, text: message.slice(0, 240) });
  if (ring.length > ROUTED_DEBUG_LOG_LIMIT) ring.splice(0, ring.length - ROUTED_DEBUG_LOG_LIMIT);
  routedDebugLog.set(agentId, ring);
  if (routedDebugLog.size > ROUTED_DEBUG_LOG_AGENTS) {
    const oldest = routedDebugLog.keys().next().value;
    if (oldest != null) routedDebugLog.delete(oldest);
  }
}

function routedDebugLogFor(agentId: string): { at: number; provider: string; text: string }[] {
  return routedDebugLog.get(agentId) ?? [];
}

function routedLogLine(dataDir: string, provider: string, agentId: string, message: string, postEvent: (family: string, payload: unknown) => void): void {
  const line = `${provider} ${agentId} ${message}`;
  appendRoutedInferenceLog(dataDir, line);
  postEvent("routed-log", { line, agentId, provider });
  noteRoutedDebugLog(agentId, provider, message);
}

function routedPromptTraceEnabled(): boolean {
  return (process.env.GROK_BOT_ROUTED_TRACE ?? "").toLowerCase().includes("prompt");
}

function routedCleanAgentMessage(message: string): string {
  return message.replace(/<\|\s*(?:eos|im_end|end|start)\s*\|>|<\s*\/?\s*eos\s*>/giu, "").trim();
}

const ROUTED_BOX_CALL_TIMEOUT_MS = 30_000;

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
  const dispatchRemote = async (method: string, args: unknown): Promise<unknown> => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.dispatchRemote(method, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`The box did not answer ${method} within 30 seconds (box control-plane is stuck; restart the box).`)), ROUTED_BOX_CALL_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (Date.now() - startedAt >= ROUTED_BOX_CALL_TIMEOUT_MS - 1_500) {
        routedLogLine(options.dataDir, "openrouter", "*", `box-unresponsive ${method}`, options.postEvent);
      }
      throw error;
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  };
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<unknown>>();
  const streamingByAgent = new Map<string, { readonly id: string; readonly content: string; readonly timestampMs: number }>();
  const chromeOpenByAgent = new Set<string>();
  const turnControllers = new Map<string, AbortController>();
  const turnActivities = new Map<string, { stop(): void }>();
  const queuedTurnGenerations = new Map<string, number>();
  const turnSlotByAgent = new Map<string, string>();
  const queuedAtByAgent = new Map<string, number>();

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
  // Coordinator-executed automation runs: the box's automation runtime needs its
  // own inference credential (never provisioned in this runtime), so routine
  // runs are executed here on the routed path and their history is overlaid
  // onto the gateway's automation records.
  const automationRunsPath = join(options.dataDir, "automation-runs.json");
  const loadAutomationRuns = async (): Promise<Record<string, AutomationRunRecord[]>> => {
    try {
      const parsed = JSON.parse(await readFile(automationRunsPath, "utf8")) as { automations?: Record<string, AutomationRunRecord[]> };
      return parsed.automations ?? {};
    } catch { return {}; }
  };
  const upsertAutomationRun = async (automationId: string, run: AutomationRunRecord): Promise<void> => {
    try {
      const runs = await loadAutomationRuns();
      const existing = runs[automationId] ?? [];
      const next = existing.filter(entry => entry.id !== run.id);
      next.push(run);
      await mkdir(dirname(automationRunsPath), { recursive: true });
      await writeFile(automationRunsPath, `${JSON.stringify({ schemaVersion: 1, automations: { ...runs, [automationId]: next.slice(-25) } }, null, 2)}\n`, { mode: 0o600 });
    } catch {}
  };
  // Auto-review gate for routed computer/browser tools: the box's runner owns
  // approvals in the desktop product, but routed turns never reach it, so the
  // router enforces the rules and parks the tool call on an approval widget
  // the shipped renderer already knows how to render and resolve.
  const pendingToolApprovals = new Map<string, {
    resolve: (approved: boolean) => void;
    agentId: string;
    entryId: string;
    toolName: string;
  }>();
  const alwaysAllowedTools = new Set<string>();
  const updateStoredEntry = async (agentId: string, id: string, patch: (entry: StoredEntry) => StoredEntry): Promise<void> => {
    await withStore(async () => {
      const current = await load();
      const entries = current.agents[agentId] ?? [];
      await persist({ ...current, agents: { ...current.agents, [agentId]: entries.map(entry => entry.id === id ? patch(entry) : entry) } });
      return current;
    });
  };
  const settleApprovalEntry = async (agentId: string, entryId: string, status: string): Promise<void> => {
    await updateStoredEntry(agentId, entryId, entry => {
      if (entry.widget?.type !== "auto-review-approval") return entry;
      return { ...entry, widget: { ...entry.widget, approval: { ...entry.widget.approval, status } } };
    });
    const current = await load();
    const stored = (current.agents[agentId] ?? []).find(entry => entry.id === entryId);
    if (stored != null) emitTranscript(agentId, "updated", projectInferenceRouterTranscriptEntry(stored));
  };
  const resolvePendingToolApproval = async (requestId: string, resolution: string): Promise<boolean> => {
    const pending = pendingToolApprovals.get(requestId);
    if (pending == null) return false;
    pendingToolApprovals.delete(requestId);
    const approved = resolution === "approved";
    if (approved) alwaysAllowedTools.add(pending.toolName);
    // Settle the card before waking the tool call so later transcript reads
    // never observe a stale pending status.
    await settleApprovalEntry(pending.agentId, pending.entryId, approved ? "allowed" : "denied");
    pending.resolve(approved);
    return true;
  };
  const expirePendingToolApproval = (requestId: string): boolean => {
    const pending = pendingToolApprovals.get(requestId);
    if (pending == null) return false;
    pendingToolApprovals.delete(requestId);
    pending.resolve(false);
    void settleApprovalEntry(pending.agentId, pending.entryId, "expired");
    return true;
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
      let remote = await dispatchRemote("listAgents", {});
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
      let lastPublished = "";
      const publishRunning = () => {
        if (!live) return;
        const controller = turnControllers.get(agentId);
        if (controller?.signal.aborted) return;
        const payload = JSON.stringify(project(true, Array.isArray(remote) ? remote : []));
        if (payload === lastPublished) return;
        lastPublished = payload;
        options.postEvent("agents", { activeAgentId: agentId, agents: JSON.parse(payload) });
      };
      publishRunning();
      const pulse = setInterval(() => {
        void dispatchRemote("listAgents", {}).then(next => {
          if (Array.isArray(next)) remote = next;
          publishRunning();
        }).catch(() => publishRunning());
      }, 1_000);
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
      : await materializeRoutedSendPromptAttachments(dispatchRemote, agentId, attachmentPaths, attachmentNames);
    const videoReviewSuffix = attachmentMaterial.videoAttachments.length === 0
      ? ""
      : await reviewRoutedVideoAttachments(dispatchRemote, agentId, attachmentMaterial.videoAttachments);
    const effectivePrompt = `${prompt}${attachmentMaterial.promptSuffix}${videoReviewSuffix}`;
    const [remote, beforeUser] = await Promise.all([dispatchRemote("getAgentTranscriptTail", { id: agentId }), load()]);
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
    routedLogLine(options.dataDir, provider, agentId, `execute-enter ${hidden ? "hidden" : "visible"}`, options.postEvent);
    const turnActivity = await beginActivity(agentId);
    turnActivities.set(agentId, turnActivity);
    if (userAbort.signal.aborted) turnActivity.stop();
    let turnAbort: AbortSignal | undefined = userAbort.signal;
    let turnDeadlineMs: number | undefined = undefined;
    const log = (message: string) => routedLogLine(options.dataDir, provider, agentId, message, options.postEvent);
    try {
      // Short composing window: lets the composing state render and rapid
      // follow-up sends supersede, without adding a perceptible lag.
      await awaitRoutedRetryBackoff(options.composingDelayMs ?? 150, turnAbort);
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
    const brandNewAgent = (withUser.agents[agentId] ?? []).length === 0;
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
      const native = [...listRoutedSendToAgentToolDefinitions(), ...listRoutedAgentManagementToolDefinitions()];
      const plugins = await dispatchRemote("listRoutedMcpTools", {});
      const pluginList = Array.isArray(plugins) ? plugins : [];
      if (!drive) return mergeRoutedToolLists(native, pluginList);
      const computer = await dispatchRemote("listRoutedComputerTools", {});
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
    let approvalSequence = 0;
    let boxHandedOff = false;
    const loadRoster = async () => {
      const remote = await dispatchRemote("listAgents", {});
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
      const cleanedMessage = routedCleanAgentMessage(message);
      const routedMessage = cleanedMessage.length > 0 ? cleanedMessage : routedCleanAgentMessage(visibleText);
      if (routedMessage.length === 0) {
        log(`send-to-agent-dropped ${targetId} degenerate-model-output`);
        return routedSendToAgentEmptyAck();
      }
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
      if (cleanedMessage.length === 0) log(`send-to-agent-fallback  narration used instead of degenerate tool message`);
      const toAgent = { id: targetId, name: targetName, kind: "agent" as const };
      const fromAgent = { id: agentId, name: senderName };
      await append(agentId, [{
        provider,
        role: "assistant",
        content: routedMessage,
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
        content: routedMessage,
        id: inboundId,
        timestampMs: sentAt,
        fromAgent,
        ...(images.length === 0 ? {} : { images }),
      }]);
      emitTranscript(targetId, "appended", {
        kind: "message",
        id: inboundId,
        role: "user",
        content: routedMessage,
        fromAgent,
        isStreaming: false,
        timestampMs: sentAt,
        ...(images.length === 0 ? {} : { images }),
      });
      const wake = buildAgentInboundWakePrompt({
        from: { id: agentId, name: senderName },
        text: routedMessage,
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
      if (isRoutedAgentManagementTool(definition)) {
        if (name === ROUTED_CREATE_AGENT_TOOL_NAME) {
          const created = parseRoutedCreateAgentArgs(toolArgs);
          if (created == null) {
            log(`tool-finish ${name} ${Date.now() - started}ms needs-brief`);
            return routedComputerMcpResult({ text: routedCreateAgentNeedsBriefAck(), isError: true });
          }
          let remote: unknown;
          try {
            remote = await dispatchRemote("createAgent", {
              description: created.description,
              name: created.name ?? "New bot",
              origin: "agent",
            });
          } catch (error) {
            log(`tool-error ${name} ${error instanceof Error ? error.message : String(error)}`);
            return routedComputerMcpResult({ text: routedAgentManagementFailedAck(error instanceof Error ? error.message : String(error)), isError: true });
          }
          const agentRow = (asRecord(remote)?.agent ?? asRecord(remote)) as Record<string, unknown> | null;
          const newId = typeof agentRow?.id === "string" ? agentRow.id : "";
          const newName = typeof agentRow?.name === "string" && agentRow.name.trim().length > 0 ? agentRow.name.trim() : created.name ?? "New bot";
          if (newId.length === 0) {
            log(`tool-error ${name} gateway returned no agent id`);
            return routedComputerMcpResult({ text: routedAgentManagementFailedAck("gateway returned no agent id"), isError: true });
          }
          enqueueTurn(newId, provider, { agentId: newId, prompt: buildRoutedAgentIntroductionWakePrompt(created.description), hidden: true, clientNonce: randomUUID() });
          log(`create-agent ${newId} (${newName})`);
          log(`tool-finish ${name} ${Date.now() - started}ms`);
          return routedComputerMcpResult({ text: routedCreateAgentAck(newName, newId) });
        }
        const update = parseRoutedUpdateAgentArgs(toolArgs);
        if (update == null) {
          log(`tool-finish ${name} ${Date.now() - started}ms needs-fields`);
          return routedComputerMcpResult({ text: routedUpdateAgentNeedsFieldsAck(), isError: true });
        }
        const targetId = update.self ? agentId : update.agentId ?? "";
        const targetName = (await loadRoster()).find(agent => agent.id === targetId);
        if (targetName == null) {
          log(`tool-error ${name} missing ${targetId}`);
          return routedComputerMcpResult({ text: routedAgentManagementFailedAck(`no agent with id ${targetId}`), isError: true });
        }
        try {
          await dispatchRemote("updateAgent", { id: targetId, name: update.name, description: update.description });
        } catch (error) {
          log(`tool-error ${name} ${error instanceof Error ? error.message : String(error)}`);
          return routedComputerMcpResult({ text: routedAgentManagementFailedAck(error instanceof Error ? error.message : String(error)), isError: true });
        }
        log(`update-agent ${targetId}${update.self ? " self" : ""}`);
        log(`tool-finish ${name} ${Date.now() - started}ms`);
        const displayName = typeof targetName.name === "string" && targetName.name.trim().length > 0 ? targetName.name.trim() : targetId;
        return routedComputerMcpResult({ text: update.self ? routedUpdateAgentSelfAck(update.name) : routedUpdateAgentAck(displayName) });
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
        // Auto-review gate: the box's enforcement defaults to shadow (observe
        // only) until rules exist, so no rules → allow. Block rules deny,
        // allow rules permit, conflicting rules park the action on an approval
        // widget; prior "approved" decisions remember the tool for the session.
        const autoReview = settings.getAutoReviewInstructions();
        const hasBlockRules = autoReview.blockInstructions.length > 0;
        const hasAllowRules = autoReview.allowInstructions.length > 0;
        let gate: "allow" | "deny" | "ask" = "allow";
        if (autoReview.isEnabled) {
          if (hasBlockRules && !hasAllowRules) gate = "deny";
          else if (hasAllowRules && !hasBlockRules) gate = "allow";
          else if (hasBlockRules && hasAllowRules) gate = "ask";
          else if (alwaysAllowedTools.has(name)) gate = "allow";
          else gate = "allow";
        }
        if (gate === "deny") {
          log(`tool-deny auto-review ${name}`);
          return routedComputerMcpResult({ text: "That action is blocked by your Auto-review rules, so it was not run.", isError: true });
        }
        if (gate === "ask") {
          const requestId = randomUUID();
          const approvalId = `t${turn}ar${approvalSequence += 1}`;
          const summary = `Use the computer (${name})`;
          const approval = { requestId, surface: "computer", summary, reason: "Auto-review asks before this action.", status: "pending" };
          const widgetEntry = {
            kind: "send-message",
            id: approvalId,
            message: { type: "auto-review-approval", approval },
            timestampMs: now(),
          };
          await append(agentId, [{
            provider,
            role: "assistant",
            content: summary,
            id: approvalId,
            widget: { type: "auto-review-approval", approval },
            timestampMs: now(),
          }]);
          emitTranscript(agentId, "appended", widgetEntry);
          log(`tool-approval requested ${name} ${requestId}`);
          const approved = await new Promise<boolean>(resolve => {
            pendingToolApprovals.set(requestId, { resolve, agentId, entryId: approvalId, toolName: name });
            setTimeout(() => { if (pendingToolApprovals.get(requestId) != null) expirePendingToolApproval(requestId); }, 600_000).unref?.();
          });
          if (!approved) {
            log(`tool-deny approval ${name} ${requestId}`);
            return routedComputerMcpResult({ text: "That action was not approved, so it was not run.", isError: true });
          }
          log(`tool-approval granted ${name} ${requestId}`);
        }
      } else {
        screenshotStreak = 0;
      }
      try {
        const result = await dispatchRemote(
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
    turnSlotByAgent.set(agentId, slot);
    queuedAtByAgent.delete(agentId);
    const promptChars = messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
    log(`turn-start ${slot} ${messages.length} msgs ${promptChars} chars`);
    try {
      const listedTools = await listRoutedTools();
      const pluginTools = listedTools.some((tool) => {
        const row = asRecord(tool) ?? {};
        return !isRoutedComputerTool(row) && !isRoutedSendToAgentTool(row) && !isRoutedAgentManagementTool(row);
      });
      if (!hidden && !pluginTools && !drive && promptLooksLikeComposioPluginUse(effectivePrompt)) {
        await persistThenEmit(assistantId, COMPOSIO_TOOLS_MISSING_MESSAGE, assistantTimestampMs);
        log("turn-finish composio-tools-missing");
        return { accepted: true, clientNonce, provider };
      }
      const roster = await loadRoster();
      const systemExtraBase = await loadRoutedSystemExtra(
        dispatchRemote,
        agentId,
        renderAgentDirectorySystemPrompt(routedTeammatesOf(roster, agentId)),
      );
      const selfProfile = roster.find(agent => agent.id === agentId);
      const introductionClause = hidden ? null : routedNewAgentIntroductionClause(
        typeof selfProfile?.name === "string" && selfProfile.name.trim().length > 0 ? selfProfile.name.trim() : undefined,
        typeof selfProfile?.description === "string" ? selfProfile.description : undefined,
      );
      const systemExtraComputed = brandNewAgent && introductionClause != null
        ? `${systemExtraBase}${systemExtraBase.trim().length > 0 ? "\n\n" : ""}${introductionClause}`
        : systemExtraBase;
      // Group member turns replace the persona/directory extra with the room's
      // system prompt (matches the box runner's createGroupMemberRunner).
      const systemExtra = typeof args.systemExtraOverride === "string" && args.systemExtraOverride.trim().length > 0
        ? args.systemExtraOverride
        : systemExtraComputed;
      if (drive) {
        const url = extractRoutedBrowserUrl(effectivePrompt);
        if (url != null && shouldSkipRoutedBoxChromeReload(url, chromeOpenByAgent.has(agentId))) {
          log("box-chrome-auto-skip already-open");
        } else if (url != null) {
          log(`box-chrome-auto ${url}`);
          turnActivity.reveal({ composing: false, activity: { kind: "tool", tool: ROUTED_BOX_CHROME_TOOL_NAME, callId: `box-chrome-auto-t${turn}` } });
          try {
            await dispatchRemote("executeRoutedComputerTool", {
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
      const timeoutMs = options.turnTimeoutMs ?? routedTurnTimeoutMs(drive);
      turnDeadlineMs = timeoutMs;
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
          turnTimeoutMs: timeoutMs,
        } : { mcpServerUrl: session.bridge.url, onTextDelta, onProgress, abortSignal, maxSteps, slot, pluginTools, systemExtra, turnTimeoutMs: timeoutMs });
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
        const content = routedSettledAssistantContent(visibleText, new Error(`Turn timed out after ${Math.round((turnDeadlineMs ?? 0) / 1000)}s — the provider stream stalled or the session ran longer than the deadline.`));
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
      if (turnSlotByAgent.get(agentId) === slot) turnSlotByAgent.delete(agentId);
      if (!turnActivities.has(agentId)) turnActivity.stop();
    }
    // Group orchestration needs the member's reply text; every settle path
    // (success, stop, timeout, error) funnels through persistThenEmit.
    return { accepted: true, clientNonce, provider, text: lastSettled?.content ?? "" };
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
    const queued = next.finally(() => {
      if (queues.get(agentId) === queued) queues.delete(agentId);
      if (queuedAtByAgent.get(agentId) != null && !queues.has(agentId)) queuedAtByAgent.delete(agentId);
    });
    queuedAtByAgent.set(agentId, now());
    queues.set(agentId, queued);
    void queued.catch(() => undefined);
    return queued;
  };

  void load();
  // Multi-bot group turns on the routed path: the box's group orchestrator
  // needs its own inference credential (never provisioned here), so the router
  // drives the round-robin itself with the shared pure helpers and posts each
  // member reply to the group transcript with author attribution.
  const runRoutedGroupTurn = async (
    provider: Exclude<SandInferenceProvider, "cursor">,
    record: Record<string, unknown>,
    groupAgent: Record<string, unknown>,
  ): Promise<{ handled: true; value: unknown }> => {
    const groupAgentId = typeof record.agentId === "string" ? record.agentId : "";
    const prompt = typeof record.prompt === "string" ? record.prompt : "";
    const clientNonce = typeof record.clientNonce === "string" ? record.clientNonce : randomUUID();
    const noop = { handled: true as const, value: { accepted: true, clientNonce, provider } };
    if (groupAgentId.length === 0 || prompt.trim().length === 0) return noop;
    const roster = await dispatchRemote("listAgents", {});
    const rosterById = new Map<string, Record<string, unknown>>();
    for (const row of Array.isArray(roster) ? roster : []) {
      const entry = asRecord(row);
      if (entry != null && typeof entry.id === "string") rosterById.set(entry.id, entry);
    }
    const rawMemberIds = Array.isArray(groupAgent.memberIds) ? groupAgent.memberIds : [];
    const members = rawMemberIds
      .filter((id): id is string => typeof id === "string" && rosterById.has(id))
      .map(id => {
        const profile = rosterById.get(id)!;
        return {
          id,
          name: typeof profile.name === "string" && profile.name.trim().length > 0 ? profile.name.trim() : "Bot",
          description: typeof profile.description === "string" ? profile.description : "",
        };
      });
    if (members.length === 0) return noop;
    const group = {
      name: typeof groupAgent.name === "string" ? groupAgent.name : "",
      description: typeof groupAgent.description === "string" ? groupAgent.description : "",
    };
    const history: GroupMessage[] = [{ speaker: { kind: "user" }, content: prompt.trim() }];
    const timestampMs = now();
    const userEntryId = `g${timestampMs}u`;
    const userEntry = {
      kind: "message",
      id: userEntryId,
      role: "user",
      content: prompt,
      fromUser: { name: "You" },
      isStreaming: false,
      timestampMs,
      clientNonce,
    };
    await append(groupAgentId, [{
      provider,
      role: "user",
      content: prompt,
      id: userEntryId,
      fromUser: userEntry.fromUser,
      clientNonce,
      timestampMs,
    }]);
    emitTranscript(groupAgentId, "appended", userEntry);
    routedLogLine(options.dataDir, provider, groupAgentId, `group-turn members=${members.length}`, options.postEvent);

    let totalMessages = 0;
    for (let round = 0; round < GROUP_MAX_ROUNDS; round += 1) {
      const responderIds = resolveResponders(members, history).map(member => member.id);
      let messagesThisRound = 0;
      for (const memberId of orderRoundSpeakers(responderIds, round)) {
        if (totalMessages >= GROUP_MAX_MEMBER_TURNS) break;
        const member = members.find(candidate => candidate.id === memberId);
        if (member == null) continue;
        const peers = members.filter(candidate => candidate.id !== member.id);
        const systemExtraOverride = buildGroupMemberSystemPrompt(member, group, peers);
        const memberPrompt = buildGroupTurnPrompt({
          member,
          group,
          peers,
          newMessages: messagesSinceMemberLastSpoke(history, member.id),
        });
        const outcome = await enqueueTurn(member.id, provider, {
          agentId: member.id,
          prompt: memberPrompt,
          hidden: true,
          clientNonce: randomUUID(),
          systemExtraOverride,
        });
        const outcomeRecord = outcome != null && typeof outcome === "object" ? outcome as Record<string, unknown> : undefined;
        const outcomeText = typeof outcomeRecord?.text === "string" ? outcomeRecord.text : "";
        const text = outcomeText.trim();
        if (text.length === 0 || isPassContent(text)) continue;
        const replyTimestampMs = now();
        const replyId = `g${replyTimestampMs}s${totalMessages}`;
        const author = { id: member.id, name: member.name };
        await append(groupAgentId, [{
          provider,
          role: "assistant",
          content: text,
          id: replyId,
          author,
          timestampMs: replyTimestampMs,
        }]);
        emitTranscript(groupAgentId, "appended", {
          kind: "send-message",
          id: replyId,
          message: { type: "text", content: text },
          author,
          timestampMs: replyTimestampMs,
        });
        history.push({ speaker: { kind: "member", id: member.id, name: member.name }, content: text });
        totalMessages += 1;
        messagesThisRound += 1;
      }
      if (messagesThisRound === 0) break;
    }
    routedLogLine(options.dataDir, provider, groupAgentId, `group-turn finished ${totalMessages} replies`, options.postEvent);
    return { handled: true, value: { accepted: true, clientNonce, provider } };
  };
  const debugSnapshot = (): Record<string, unknown> => {
    const current = snapshot;
    const ids = new Set<string>([
      ...Object.keys(current.agents),
      ...turnControllers.keys(),
      ...queues.keys(),
      ...streamingByAgent.keys(),
      ...routedDebugLog.keys(),
    ]);
    ids.delete("(none)");
    const bots: Record<string, unknown>[] = [];
    for (const id of ids) {
      const controller = turnControllers.get(id);
      const running = controller != null && !controller.signal.aborted;
      const entries = current.agents[id] ?? [];
      let name: string | undefined;
      for (let index = entries.length - 1; index >= 0 && name == null; index -= 1) {
        const entry = entries[index]!;
        const ref = entry.toAgent?.id === id ? entry.toAgent : entry.fromAgent?.id === id ? entry.fromAgent : entry.author?.id === id ? entry.author : undefined;
        if (ref != null && ref.name.length > 0) name = ref.name;
      }
      const logRing = routedDebugLogFor(id);
      const lastActivity = logRing.at(-1)?.at ?? null;
      const streaming = streamingByAgent.get(id)?.content.trim() ?? "";
      bots.push({
        id,
        name: name ?? id,
        state: running ? "running" : queues.has(id) ? "queued" : "idle",
        slot: turnSlotByAgent.get(id) ?? null,
        queuedAt: queuedAtByAgent.get(id) == null ? null : new Date(queuedAtByAgent.get(id)!).toISOString(),
        streamingPreview: streaming.length > 0 ? streaming.slice(-240) : null,
        lastActivityAt: lastActivity == null ? null : new Date(lastActivity).toISOString(),
        pendingApprovals: [...pendingToolApprovals.values()].filter(pending => pending.agentId === id).length,
        recentLog: logRing.slice(-5).map(line => ({ at: new Date(line.at).toISOString(), provider: line.provider, text: line.text })),
      });
    }
    const summaryProvider = settings.getInferenceProvider();
    return {
      generatedAt: new Date().toISOString(),
      inference: routedInferenceSummary(summaryProvider === "cursor" ? "openrouter" : summaryProvider),
      bots,
      unassignedLog: routedDebugLogFor("(none)").map(line => ({ at: new Date(line.at).toISOString(), provider: line.provider, text: line.text })),
    };
  };
  return {
    provider(): SandInferenceProvider { return settings.getInferenceProvider(); },
    debugSnapshot,
    async dispatch(method: string, args: unknown): Promise<{ handled: boolean; value?: unknown }> {
      const provider = settings.getInferenceProvider();
      if (method === "getRoutedDebug") return { handled: true, value: debugSnapshot() };
      if (method === "resolveAutoReviewApproval") {
        // Routed-turn approval cards are settled here (the box runner is
        // bypassed on this path).
        const record = asRecord(args) ?? {};
        const requestId = typeof record.requestId === "string" ? record.requestId : "";
        const resolution = typeof record.resolution === "string" ? record.resolution : "";
        const resolved = requestId.length > 0 ? await resolvePendingToolApproval(requestId, resolution) : false;
        return { handled: true, value: resolved };
      }
      if (method === "expireAutoReviewApprovals" || method === "dismissWidget") {
        const record = asRecord(args) ?? {};
        const requestId = typeof record.requestId === "string" ? record.requestId : "";
        if (requestId.length > 0) expirePendingToolApproval(requestId);
        return { handled: true, value: null };
      }
      if (method === "resolveAgentCreation") {
        // The 0.36 renderer resolves a creation route before createAgent; the
        // reconstruction always creates agents locally on the box.
        return { handled: true, value: { kind: "box" } };
      }
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
        const remote = await dispatchRemote(method, args);
        const local = await load();
        return { handled: true, value: stampLiveTurnState(overlayRoutedRosterLastEntry(remote, local)) };
      }
      if (provider !== "cursor" && method === "searchAgents") {
        // The 0.36 palette's cross-conversation message search asks the gateway
        // (roster-search on the box), but routed transcripts persist in this
        // coordinator's store — the box never sees them, so a pure forward
        // always answers []. Scan the routed store and merge with the gateway.
        const record = asRecord(args) ?? {};
        const query = typeof record.query === "string" ? record.query.trim().toLowerCase() : "";
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 20;
        if (query.length === 0) return { handled: true, value: [] };
        const local = await load();
        const results: Record<string, unknown>[] = [];
        for (const [agentId, entries] of Object.entries(local.agents)) {
          for (const entry of entries) {
            const index = entry.content.toLowerCase().indexOf(query);
            if (index < 0) continue;
            const start = Math.max(0, index - 48);
            const end = Math.min(entry.content.length, index + query.length + 96);
            results.push({
              agentId,
              entryId: entry.id,
              role: entry.role,
              timestampMs: entry.timestampMs,
              snippet: `${start > 0 ? "…" : ""}${entry.content.slice(start, end)}${end < entry.content.length ? "…" : ""}`,
            });
          }
        }
        const remote = await dispatchRemote(method, args);
        const merged = [...(Array.isArray(remote) ? remote : []), ...results];
        const seen = new Set<string>();
        const deduped = merged.filter((row) => {
          const entry = asRecord(row);
          const key = `${typeof entry?.agentId === "string" ? entry.agentId : ""}:${typeof entry?.entryId === "string" ? entry.entryId : ""}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        deduped.sort((left, right) => Number(asRecord(right)?.timestampMs ?? 0) - Number(asRecord(left)?.timestampMs ?? 0));
        return { handled: true, value: deduped.slice(0, limit) };
      }
      if (provider !== "cursor" && method === "runAgentAutomationNow") {
        // The box automation runtime gates fires on its own inference
        // credential (canExecute), which this runtime never provisions — every
        // Test run / manual fire would dead-end there. Resolve the routine's
        // prompt and execute it on the routed path instead, recording the run
        // so the routine's history reflects it.
        const record = asRecord(args) ?? {};
        // The 0.36 renderer addresses the agent as `id` in this call.
        const agentId = typeof record.id === "string" ? record.id : typeof record.agentId === "string" ? record.agentId : "";
        const automationId = typeof record.automationId === "string" ? record.automationId : "";
        routedLogLine(options.dataDir, provider, agentId || "(none)", `automation-run request automation=${automationId || "(none)"}`, options.postEvent);
        if (agentId.length === 0 || automationId.length === 0) return { handled: true, value: null };
        const automations = await dispatchRemote("getAgentAutomations", { id: agentId });
        routedLogLine(options.dataDir, provider, agentId, `automation-run lookup rows=${Array.isArray(automations) ? automations.length : "non-array"}`, options.postEvent);
        const automation = Array.isArray(automations)
          ? automations.find(row => asRecord(row)?.id === automationId)
          : null;
        const automationRecord = asRecord(automation);
        const prompt = typeof automationRecord?.prompt === "string" ? automationRecord.prompt : "";
        routedLogLine(options.dataDir, provider, agentId, `automation-run resolved prompt=${prompt.length} chars`, options.postEvent);
        if (automationRecord == null || prompt.length === 0) return { handled: true, value: null };
        const runId = `run-${randomUUID()}`;
        const startedAt = now();
        await upsertAutomationRun(automationId, { id: runId, status: "running", trigger: "manual", startedAt });
        const queued = enqueueTurn(agentId, provider, { agentId, prompt, clientNonce: randomUUID() });
        void queued
          .then(outcome => upsertAutomationRun(automationId, { id: runId, status: outcome != null && typeof outcome === "object" && (outcome as Record<string, unknown>).accepted === true ? "ok" : "error", trigger: "manual", startedAt, finishedAt: now() }))
          .catch(() => upsertAutomationRun(automationId, { id: runId, status: "error", trigger: "manual", startedAt, finishedAt: now() }));
        return { handled: true, value: undefined };
      }
      if (provider !== "cursor" && method === "getAgentAutomations") {
        // Overlay coordinator-recorded run history onto the gateway's records
        // (the box only records runs it fired itself).
        const remote = await dispatchRemote(method, args);
        if (!Array.isArray(remote)) return { handled: true, value: remote };
        const runs = await loadAutomationRuns();
        const merged = remote.map(row => {
          const record = asRecord(row);
          if (record == null) return row;
          const id = typeof record.id === "string" ? record.id : "";
          const localRuns = runs[id];
          if (localRuns == null || localRuns.length === 0) return row;
          const gatewayRuns = Array.isArray(record.runs) ? record.runs : [];
          const byId = new Set(gatewayRuns.map(run => asRecord(run)?.id).filter(value => typeof value === "string"));
          const combined = [...gatewayRuns, ...localRuns.filter(run => !byId.has(run.id))]
            .sort((left, right) => Number(asRecord(right)?.startedAt ?? 0) - Number(asRecord(left)?.startedAt ?? 0))
            .slice(0, 25);
          const newest = combined[0];
          return {
            ...record,
            runs: combined,
            lastRunAt: Math.max(Number(record.lastRunAt ?? 0), Number(asRecord(newest)?.startedAt ?? 0)),
          };
        });
        return { handled: true, value: merged };
      }
      if (provider !== "cursor" && ["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"].includes(method)) {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.id === "string" ? record.id : "";
        const remote = await dispatchRemote(method, args);
        if (agentId.length > 0) {
          const roster = await dispatchRemote("listAgents", {});
          if (Array.isArray(roster)) {
            const target = roster.find((row) => {
              const entry = asRecord(row);
              return entry != null && entry.id === agentId;
            });
            if (asRecord(target)?.isGroup === true) {
              // Group transcripts merge routed local entries (orchestrated
              // member replies, room user messages) with the box's own history.
              const localGroup = await load();
              const groupResult = asRecord(remote);
              const persistedGroup = (localGroup.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry);
              const groupEntries = Array.isArray(groupResult?.entries) ? groupResult.entries : [];
              const combinedGroup = [...groupEntries, ...persistedGroup];
              const limitGroup = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
              return { handled: true, value: { ...(groupResult ?? {}), entries: combinedGroup.slice(-limitGroup) } };
            }
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
        const remote = await dispatchRemote(method, args);
        await dropAgents(ids);
        // The 0.36 renderer removes deleted rows locally only when its roster
        // store generation still matches the reply; after a transport hiccup
        // the rows linger. Push a fresh roster snapshot so the sidebar always
        // reflects the deletion immediately.
        try {
          const agents = await dispatchRemote("listAgents", {});
          if (Array.isArray(agents)) options.postEvent("agents", { agents });
        } catch {}
        return { handled: true, value: remote };
      }
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      if (agentId.length > 0) {
        const remote = await dispatchRemote("listAgents", {});
        if (Array.isArray(remote)) {
          const target = remote.find((row) => {
            const entry = asRecord(row);
            return entry != null && entry.id === agentId;
          });
          if (asRecord(target)?.isGroup === true) return await runRoutedGroupTurn(provider, record, asRecord(target)!);
        }
      }
      const clientNonce = typeof record.clientNonce === "string" ? record.clientNonce : randomUUID();
      routedLogLine(options.dataDir, provider, agentId || "(none)", "dispatch sendPrompt queued", options.postEvent);
      if (agentId.length > 0) abortAgentTurn(agentId, "supersede");
      const queuedValue = enqueueTurn(agentId, provider, { ...record, clientNonce });
      void queuedValue.finally(() => routedLogLine(options.dataDir, provider, agentId || "(none)", "dispatch sendPrompt settled", options.postEvent));
      return { handled: true, value: { accepted: true, clientNonce, provider } };
    },
    overlayAgents,
  };
}
