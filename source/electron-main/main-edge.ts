import { isSandAgentModelSelection, resolveComputerUseModelSelection } from "../shared/agents/sand-agent-model.js";
import { normalizeSandAutoReviewInstructions } from "../shared/sand-auto-review-instructions.js";
import { isSandLocalToolAction, normalizeSandLocalToolPermission } from "../shared/local-tool-permission.js";
import { isSandThemePreference } from "../shared/desktop.js";
import { isSandUpdateTrack } from "../shared/update-track.js";
import { isValidIanaTimeZone } from "../shared/timezone.js";
import { sandWebauthnProxyMirroredEnablement } from "../shared/webauthn-proxy-availability.js";
import { reportDesktopEdgeFailure } from "./desktop-edge-failures.js";
import { isSandInferenceProvider, type SandInferenceRouterUsage } from "../shared/inference-router.js";
import { openRouterUsageToCursorSummary } from "../shared/openrouter-usage-summary.js";
import { DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT, DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_REASONING_EFFORT, normalizeOpenRouterModelId, normalizeOpenRouterReasoningEffort, resolveOpenRouterComputerModel, resolveOpenRouterModel, resolveOpenRouterReasoningEffort, resolveOpenRouterSummarizeModel } from "../shared/openrouter-models.js";
import { fetchOpenRouterCatalog, readOpenRouterApiKey } from "../shared/node/openrouter-models.js";
import { getLocalInferenceCliStatus } from "../shared/node/inference-router-local.js";
import { isSandBoxRuntime } from "../shared/box-runtime.js";
import { normalizeBoxAutoSuspendIdleMs } from "../shared/box-idle-suspend.js";
import { getLocalDockerStatus, startLocalDockerBox, stopLocalDockerBox } from "./box/local-docker-host-connector.js";
import { getRegisteredBoxIdleSuspendService } from "./box/box-idle-suspend.js";

export const MAIN_EDGE_UNSERVED = "main/unserved-method";
export const MAIN_EDGE_UPDATE_UNAVAILABLE = "main/update-unavailable";
export const MAIN_EDGE_THEME_UNAVAILABLE = "main/theme-unavailable";
export const MAIN_EDGE_EGRESS_TUNNEL_UNAVAILABLE = "main/egress-tunnel-unavailable";

type UnknownRecord = Record<string, unknown>;
type Handler = (request: UnknownRecord) => unknown;
type HandlerMap = Record<string, Handler>;
export type ServedMainEdgeHandlerMap = Record<string, {
  readonly trust: "appWindow";
  readonly run: (request: UnknownRecord, sender?: unknown) => unknown;
}>;

export class EdgeCallFailure extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(args: { readonly code: string; readonly detail: string }) { super(`${args.code}: ${args.detail}`); this.name = "EdgeCallFailure"; this.code = args.code; this.detail = args.detail; }
}
export class SandHostSettingsUnreachableError extends Error {}

export interface MainEdgeDeps {
  readonly readLiveUpdateService: () => UnknownRecord | null;
  readonly readThemeController: () => UnknownRecord | null;
  readonly readEgressTunnelController: () => UnknownRecord | null;
  readonly settingsStore: UnknownRecord;
  readonly agentPrefsStore: UnknownRecord;
  readonly boxToggleStore: UnknownRecord;
  readonly onboardingSeen: UnknownRecord;
  readonly shell: UnknownRecord;
  readonly boxRecovery: UnknownRecord;
  readonly windowChrome: UnknownRecord;
  readonly avatarImages: UnknownRecord;
  readonly attachments: UnknownRecord;
  readonly cursorAccount: UnknownRecord;
  readonly experiments: UnknownRecord;
  readonly syncHostSettingsToBox: (settings: UnknownRecord) => Promise<UnknownRecord | null>;
  readonly readHostSettingsFromBox: () => Promise<UnknownRecord>;
  readonly recordLocalToolApproval: (approval: { id: string; action: string; target: string }) => Promise<void>;
  readonly clearLocalToolApprovals: () => Promise<void>;
  readonly getComputerUseModelOverride: () => unknown;
  readonly fetchAvailableModels: () => unknown;
  readonly emitEgressTunnelChanged: (enabled: boolean) => void;
  readonly emitWebauthnProxyChanged: (enabled: boolean) => void;
  readonly ensureTranscriptionManager: () => Promise<UnknownRecord>;
  readonly platform: NodeJS.Platform;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly detectTimeZone?: () => string | null | undefined;
}

function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function invoke(target: UnknownRecord, method: string, ...args: unknown[]): unknown { const fn = target[method]; invariant(typeof fn === "function", `Missing main-edge dependency method ${method}.`); return Reflect.apply(fn, target, args); }
function req(value: unknown): UnknownRecord { return typeof value === "object" && value != null && !Array.isArray(value) ? value as UnknownRecord : {}; }
function detectTimeZone(): string | null { const value = Intl.DateTimeFormat().resolvedOptions().timeZone; return value.length > 0 ? value : null; }
async function boxRuntimeSnapshot(deps: MainEdgeDeps) {
  const mode = invoke(deps.settingsStore, "getBoxRuntime");
  invariant(isSandBoxRuntime(mode), "Unknown box runtime.");
  const idle = getRegisteredBoxIdleSuspendService();
  const idleMs = normalizeBoxAutoSuspendIdleMs(invoke(deps.settingsStore, "getBoxAutoSuspendIdleMs"));
  const status = await getLocalDockerStatus(String(Reflect.get(deps.settingsStore, "settingsPath")));
  return { mode, status, idleMs, suspended: idle?.isSuspended() === true || idleMs > 0 && !status.running };
}
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createMainEdgeTrust() { return { appWindow: { kind: "require" as const, test: (sender: { isAppWindowTopFrame?: boolean }) => sender.isAppWindowTopFrame === true, denial: "The main edge is only accessible from the Sand app window's top frame." } }; }
export const unserved = (): never => { throw new EdgeCallFailure({ code: MAIN_EDGE_UNSERVED, detail: "This method still rides its hand-wired preload channel." }); };
function required(read: () => UnknownRecord | null, code: string, detail: string): UnknownRecord { const value = read(); if (value == null) throw new EdgeCallFailure({ code, detail }); return value; }
function updateService(deps: MainEdgeDeps) { return required(deps.readLiveUpdateService, MAIN_EDGE_UPDATE_UNAVAILABLE, "The update service is not running."); }
function themeController(deps: MainEdgeDeps) { return required(deps.readThemeController, MAIN_EDGE_THEME_UNAVAILABLE, "The theme controller is not running."); }
function egressController(deps: MainEdgeDeps) { return required(deps.readEgressTunnelController, MAIN_EDGE_EGRESS_TUNNEL_UNAVAILABLE, "The egress tunnel controller is not running."); }
async function echo(deps: MainEdgeDeps, field: string, value: unknown, label: string): Promise<unknown> { const result = await deps.syncHostSettingsToBox({ [field]: value }); if (result == null) throw new SandHostSettingsUnreachableError(`Couldn't reach the computer to save ${label}.`); return result[field] ?? null; }
function computerUseModel(deps: MainEdgeDeps): unknown { const stored = invoke(deps.agentPrefsStore, "getComputerUseModel"); const override = deps.getComputerUseModelOverride(); return resolveComputerUseModelSelection({ ...(isSandAgentModelSelection(stored) ? { storedModel: stored } : {}), ...(isSandAgentModelSelection(override) ? { overrideModel: override } : {}) }) ?? null; }
function openRouterModel(deps: MainEdgeDeps): string {
  try { return resolveOpenRouterModel(invoke(deps.settingsStore, "getOpenRouterModel")); }
  catch { return resolveOpenRouterModel(undefined); }
}
function storedOpenRouterComputerModel(deps: MainEdgeDeps): string | null {
  try {
    const stored = invoke(deps.settingsStore, "getOpenRouterComputerModel");
    return normalizeOpenRouterModelId(stored) ?? null;
  } catch { return null; }
}
function storedOpenRouterSummarizeModel(deps: MainEdgeDeps): string | null {
  try {
    const stored = invoke(deps.settingsStore, "getOpenRouterSummarizeModel");
    return normalizeOpenRouterModelId(stored) ?? null;
  } catch { return null; }
}
function openRouterComputerModel(deps: MainEdgeDeps): string {
  return resolveOpenRouterComputerModel(storedOpenRouterComputerModel(deps));
}
function openRouterSummarizeModel(deps: MainEdgeDeps): string {
  return resolveOpenRouterSummarizeModel(storedOpenRouterSummarizeModel(deps), openRouterModel(deps));
}
function storedOpenRouterReasoningEffort(deps: MainEdgeDeps): string {
  try { return resolveOpenRouterReasoningEffort(invoke(deps.settingsStore, "getOpenRouterReasoningEffort"), DEFAULT_OPENROUTER_REASONING_EFFORT); }
  catch { return DEFAULT_OPENROUTER_REASONING_EFFORT; }
}
function storedOpenRouterComputerReasoningEffort(deps: MainEdgeDeps): string {
  try { return resolveOpenRouterReasoningEffort(invoke(deps.settingsStore, "getOpenRouterComputerReasoningEffort"), DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT); }
  catch { return DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT; }
}
async function openRouterUsageSummary(deps: MainEdgeDeps) {
  const settings = await deps.readHostSettingsFromBox().catch(() => ({} as UnknownRecord));
  const usage = (settings.inferenceRouterUsage ?? invoke(deps.settingsStore, "getInferenceRouterUsage")) as SandInferenceRouterUsage | undefined;
  return openRouterUsageToCursorSummary(usage);
}
function inferenceRouterSnapshot(deps: MainEdgeDeps, extra: UnknownRecord = {}): UnknownRecord {
  const provider = invoke(deps.settingsStore, "getInferenceProvider");
  return {
    provider: isSandInferenceProvider(provider) ? provider : "openrouter",
    model: openRouterModel(deps),
    computerModel: storedOpenRouterComputerModel(deps),
    summarizeModel: storedOpenRouterSummarizeModel(deps),
    reasoningEffort: storedOpenRouterReasoningEffort(deps),
    computerReasoningEffort: storedOpenRouterComputerReasoningEffort(deps),
    ...extra,
    local: extra.local ?? getLocalInferenceCliStatus(),
  };
}
function parseAgentModel(value: unknown, requireNonWhitespaceId: boolean): { modelId: string; maxMode: boolean; parameters: { id: string; value: string }[] } | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const record = value as UnknownRecord;
  if (typeof record.modelId !== "string" || record.modelId.length === 0 || (requireNonWhitespaceId && record.modelId.trim().length === 0) || typeof record.maxMode !== "boolean" || !Array.isArray(record.parameters)) return null;
  const parameters: { id: string; value: string }[] = [];
  for (const raw of record.parameters) { if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return null; const parameter = raw as UnknownRecord; if (typeof parameter.id !== "string" || parameter.id.length === 0 || typeof parameter.value !== "string") return null; parameters.push({ id: parameter.id, value: parameter.value }); }
  return { modelId: record.modelId, maxMode: record.maxMode, parameters };
}

export function createMainEdgeHandlers(deps: MainEdgeDeps): HandlerMap {
  const handlers: HandlerMap = {
    getUpdateStatus: () => invoke(updateService(deps), "getStatus"),
    checkForUpdates: () => invoke(updateService(deps), "checkForUpdates", { trigger: "explicit" }),
    setUpdateTrack: (raw) => { const { track } = req(raw); const service = updateService(deps); return track === null ? invoke(service, "setTrackOverride", null) : isSandUpdateTrack(track) ? invoke(service, "setTrackOverride", track) : invoke(service, "getStatus"); },
    quitAndInstallUpdate: () => { invoke(updateService(deps), "quitAndInstall"); },
    setAutoUpdateWhenIdleOptIn: (raw) => invoke(updateService(deps), "setAutoUpdateWhenIdleOptIn", req(raw).enabled === true),

    getTimeZone: () => ({ detectedTimeZone: (deps.detectTimeZone ?? detectTimeZone)() ?? null, overrideTimeZone: invoke(deps.settingsStore, "getUserTimeZoneOverride") ?? null }),
    setTimeZoneOverride: (raw) => { const { timeZone } = req(raw); if (timeZone === null) invoke(deps.settingsStore, "setUserTimeZoneOverride", undefined); else if (typeof timeZone === "string" && isValidIanaTimeZone(timeZone)) invoke(deps.settingsStore, "setUserTimeZoneOverride", timeZone); const detected = (deps.detectTimeZone ?? detectTimeZone)(); void deps.syncHostSettingsToBox({ ...(detected == null ? {} : { userTimeZone: detected }), userTimeZoneOverride: invoke(deps.settingsStore, "getUserTimeZoneOverride") ?? "" }); return { detectedTimeZone: (deps.detectTimeZone ?? detectTimeZone)() ?? null, overrideTimeZone: invoke(deps.settingsStore, "getUserTimeZoneOverride") ?? null }; },
    getAutoReviewInstructions: () => invoke(deps.settingsStore, "getAutoReviewInstructions"),
    setAutoReviewInstructions: async (raw) => { const value = req(raw).instructions; const instructions = typeof value === "object" && value != null && !Array.isArray(value) ? value as { isEnabled?: unknown; allowInstructions?: unknown; blockInstructions?: unknown } : undefined; const normalized = normalizeSandAutoReviewInstructions(instructions); invoke(deps.settingsStore, "setAutoReviewInstructions", normalized); try { await deps.syncHostSettingsToBox({ autoReviewInstructions: normalized }); } catch (error) { reportDesktopEdgeFailure("host-settings", "auto-review", error); } return invoke(deps.settingsStore, "getAutoReviewInstructions"); },
    getLocalToolPermission: () => invoke(deps.settingsStore, "getLocalToolPermission"),
    getLocalToolPermissionCeiling: () => invoke(deps.settingsStore, "getLocalToolPermissionCeiling") ?? null,
    setLocalToolPermission: async (raw) => { invoke(deps.settingsStore, "setLocalToolPermission", normalizeSandLocalToolPermission(req(raw).permission)); for (let attempt = 0; attempt < 3; attempt += 1) { const permission = invoke(deps.settingsStore, "getLocalToolPermission"); try { const applied = await deps.syncHostSettingsToBox({ localToolPermission: permission }); if (applied?.localToolPermission === permission) break; } catch (error) { reportDesktopEdgeFailure("host-settings", "local-tool-retry", error); } await (deps.delay ?? sleep)(250 * (attempt + 1)); } return invoke(deps.settingsStore, "getLocalToolPermission"); },
    recordLocalToolApproval: async (raw) => { const { approvalId, action, target } = req(raw); invariant(typeof approvalId === "string" && approvalId.length > 0 && isSandLocalToolAction(action) && typeof target === "string", "A local-tool approval needs its request id and action."); await deps.recordLocalToolApproval({ id: approvalId, action, target }); },
    clearLocalToolApprovals: async () => { await deps.clearLocalToolApprovals().catch((error: unknown) => reportDesktopEdgeFailure("local-tool-approvals", "clear", error)); },

    getThemeState: () => invoke(themeController(deps), "getState"),
    setThemePreference: (raw) => { const controller = themeController(deps); const preference = req(raw).preference; return isSandThemePreference(preference) ? invoke(controller, "setPreference", preference) : invoke(controller, "getState"); },
    getAgentDefaultModel: async () => { const settings = await deps.readHostSettingsFromBox(); invoke(deps.agentPrefsStore, "setAgentDefaultModel", settings.agentDefaultModel); return settings.agentDefaultModel ?? null; },
    setAgentDefaultModel: async (raw) => { const model = parseAgentModel(req(raw).model, false); if (model == null) return invoke(deps.agentPrefsStore, "getAgentDefaultModel") ?? null; const result = await deps.syncHostSettingsToBox({ agentDefaultModel: model }); if (result == null) throw new SandHostSettingsUnreachableError("Couldn't reach the computer to save the default model."); invoke(deps.agentPrefsStore, "setAgentDefaultModel", result.agentDefaultModel); return result.agentDefaultModel ?? null; },
    getComputerUseModel: () => computerUseModel(deps),
    setComputerUseModel: (raw) => { const requested = req(raw).model; const model = requested === null ? null : parseAgentModel(requested, true); if (requested === null || model != null) { invoke(deps.agentPrefsStore, "setComputerUseModel", model ?? undefined); void deps.syncHostSettingsToBox({ computerUseModel: invoke(deps.agentPrefsStore, "getComputerUseModel") ?? null }); } return computerUseModel(deps); },
    getHostPinnedAgents: async () => (await deps.readHostSettingsFromBox()).pinnedAgentIds ?? null,
    setHostPinnedAgents: (raw) => echo(deps, "pinnedAgentIds", req(raw).pinnedAgentIds, "pinned agents"),
    getHostSidebarSections: async () => (await deps.readHostSettingsFromBox()).sidebarSections ?? null,
    setHostSidebarSections: (raw) => echo(deps, "sidebarSections", req(raw).sections, "sidebar sections"),
    getAvailableModels: () => deps.fetchAvailableModels(),
    getInferenceRouter: async () => { const settings = await deps.readHostSettingsFromBox().catch(() => ({} as UnknownRecord)); return inferenceRouterSnapshot(deps, { usage: settings.inferenceRouterUsage ?? invoke(deps.settingsStore, "getInferenceRouterUsage") ?? null }); },
    setInferenceRouter: async (raw) => {
      const record = req(raw);
      const provider = record.provider;
      invariant(isSandInferenceProvider(provider), "Unknown inference provider.");
      invoke(deps.settingsStore, "setInferenceProvider", provider);
      const requested = normalizeOpenRouterModelId(record.model);
      if (requested !== undefined) invoke(deps.settingsStore, "setOpenRouterModel", requested);
      if (Object.prototype.hasOwnProperty.call(record, "computerModel")) {
        const computer = record.computerModel;
        if (computer == null || computer === "" || computer === "__inherit__") invoke(deps.settingsStore, "setOpenRouterComputerModel", undefined);
        else {
          const computerId = normalizeOpenRouterModelId(computer);
          if (computerId !== undefined) invoke(deps.settingsStore, "setOpenRouterComputerModel", computerId);
        }
      }
      if (Object.prototype.hasOwnProperty.call(record, "summarizeModel")) {
        const summarize = record.summarizeModel;
        if (summarize == null || summarize === "" || summarize === "__inherit__") invoke(deps.settingsStore, "setOpenRouterSummarizeModel", undefined);
        else {
          const summarizeId = normalizeOpenRouterModelId(summarize);
          if (summarizeId !== undefined) invoke(deps.settingsStore, "setOpenRouterSummarizeModel", summarizeId);
        }
      }
      const reasoningEffort = normalizeOpenRouterReasoningEffort(record.reasoningEffort);
      if (reasoningEffort !== undefined) invoke(deps.settingsStore, "setOpenRouterReasoningEffort", reasoningEffort);
      const computerReasoningEffort = normalizeOpenRouterReasoningEffort(record.computerReasoningEffort);
      if (computerReasoningEffort !== undefined) invoke(deps.settingsStore, "setOpenRouterComputerReasoningEffort", computerReasoningEffort);
      const model = openRouterModel(deps);
      const payloadToBox = {
        inferenceProvider: "openrouter",
        openRouterModel: model,
        openRouterComputerModel: storedOpenRouterComputerModel(deps),
        openRouterSummarizeModel: storedOpenRouterSummarizeModel(deps),
        openRouterReasoningEffort: storedOpenRouterReasoningEffort(deps),
        openRouterComputerReasoningEffort: storedOpenRouterComputerReasoningEffort(deps),
      };
      let settings: UnknownRecord | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          settings = await deps.syncHostSettingsToBox(payloadToBox);
          if (settings != null) break;
        } catch (error) {
          lastError = error;
        }
        await (deps.delay ?? sleep)(250 * (attempt + 1));
      }
      if (settings == null) {
        throw new SandHostSettingsUnreachableError(lastError instanceof Error ? lastError.message : "Couldn't reach the computer to save Router models. Start the local Docker VM and try again.");
      }
      return inferenceRouterSnapshot(deps, { usage: settings.inferenceRouterUsage ?? invoke(deps.settingsStore, "getInferenceRouterUsage") ?? null });
    },
    listOpenRouterModels: async () => {
      const model = openRouterModel(deps);
      const computerModel = openRouterComputerModel(deps);
      const summarizeModel = openRouterSummarizeModel(deps);
      const settingsPath = typeof Reflect.get(deps.settingsStore, "settingsPath") === "string" ? String(Reflect.get(deps.settingsStore, "settingsPath")) : undefined;
      const apiKey = readOpenRouterApiKey(settingsPath);
      try {
        const models = await fetchOpenRouterCatalog({ ...(apiKey === undefined ? {} : { apiKey }), currentId: [model, computerModel, summarizeModel] });
        return { model, computerModel, summarizeModel, models };
      } catch (error) {
        return {
          model,
          computerModel,
          summarizeModel,
          models: [
            { id: model, name: model, recommended: model === DEFAULT_OPENROUTER_MODEL },
            ...(computerModel === model ? [] : [{ id: computerModel, name: computerModel, recommended: false }]),
            ...(summarizeModel === model || summarizeModel === computerModel ? [] : [{ id: summarizeModel, name: summarizeModel, recommended: false }]),
          ],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    getBoxRuntime: async () => await boxRuntimeSnapshot(deps),
    setBoxRuntime: async (raw) => { const mode = req(raw).mode; invariant(isSandBoxRuntime(mode), "Unknown box runtime."); const settingsPath = String(Reflect.get(deps.settingsStore, "settingsPath")); const previous = invoke(deps.settingsStore, "getBoxRuntime"); invoke(deps.settingsStore, "setBoxRuntime", mode); try { if (mode === "local-docker") await startLocalDockerBox(settingsPath); else await stopLocalDockerBox(); } catch (error) { if (isSandBoxRuntime(previous)) invoke(deps.settingsStore, "setBoxRuntime", previous); throw error; } invoke(deps.boxRecovery, "restartCoordinator"); return await boxRuntimeSnapshot(deps); },
    setBoxAutoSuspendIdleMs: async (raw) => {
      const idleMs = normalizeBoxAutoSuspendIdleMs(req(raw).idleMs);
      invoke(deps.settingsStore, "setBoxAutoSuspendIdleMs", idleMs);
      getRegisteredBoxIdleSuspendService()?.noteIdleMsChanged();
      return await boxRuntimeSnapshot(deps);
    },
    suspendBox: async () => {
      const idle = getRegisteredBoxIdleSuspendService();
      if (idle == null) await stopLocalDockerBox();
      else await idle.suspend();
      return await boxRuntimeSnapshot(deps);
    },
    resumeBox: async () => {
      const idle = getRegisteredBoxIdleSuspendService();
      if (idle == null) {
        await startLocalDockerBox(String(Reflect.get(deps.settingsStore, "settingsPath")));
        invoke(deps.boxRecovery, "restartCoordinator");
      } else await idle.resume();
      return await boxRuntimeSnapshot(deps);
    },

    getEgressTunnelEnabled: () => invoke(deps.boxToggleStore, "getEgressTunnelEnabled"),
    setEgressTunnelEnabled: (raw) => { const enabled = req(raw).enabled === true; invoke(deps.boxToggleStore, "setEgressTunnelEnabled", enabled); invoke(egressController(deps), "setEnabled", enabled); deps.emitEgressTunnelChanged(enabled); return enabled; },
    getEgressTunnelStatus: () => invoke(egressController(deps), "getStatus"),
    getWebauthnProxyEnabled: () => invoke(deps.boxToggleStore, "getWebauthnProxyEnabled"),
    setWebauthnProxyEnabled: async (raw) => { const enabled = req(raw).enabled === true; invoke(deps.boxToggleStore, "setWebauthnProxyEnabled", enabled); deps.emitWebauthnProxyChanged(enabled); const mirrored = sandWebauthnProxyMirroredEnablement(enabled, deps.platform); for (let attempt = 0; attempt < 3; attempt += 1) { const applied = await deps.syncHostSettingsToBox({ webauthnProxyEnabled: mirrored }); if (applied?.webauthnProxyEnabled === mirrored) break; await (deps.delay ?? sleep)(250 * (attempt + 1)); } return invoke(deps.boxToggleStore, "getWebauthnProxyEnabled"); },
    getOnboardingSeen: async () => await Promise.resolve(invoke(deps.onboardingSeen, "reconcile")) === true,
    setOnboardingSeen: (raw) => { const seen = req(raw).seen; if (typeof seen === "boolean") void Promise.resolve(invoke(deps.onboardingSeen, "apply", seen)); },

    openExternal: (raw) => invoke(deps.shell, "openExternalUrl", req(raw).url),
    openCloudAgent: async (raw) => { const bcId = typeof req(raw).bcId === "string" ? (req(raw).bcId as string).trim() : ""; if (bcId.length === 0) return; const base = process.env.SAND_CURSOR_WEBSITE_URL?.trim() || process.env.CURSOR_WEBSITE_URL?.trim() || "https://cursor.com"; await Promise.resolve(invoke(deps.shell, "openInSystemBrowser", new URL(`/agents/${encodeURIComponent(bcId)}`, base).toString())); },
    submitFeedback: (raw) => invoke(deps.shell, "submitFeedback", raw),
    markDeepLinksReady: () => { invoke(deps.shell, "markDeepLinksReady"); },
    getBoxMigrationStatus: () => invoke(deps.boxRecovery, "readBoxMigrationStatus"),
    forceReconnectGateway: () => { invoke(deps.boxRecovery, "restartCoordinator"); },
    forceRecreateComputer: () => invoke(deps.boxRecovery, "forceRecreateComputer"),
    updateComputer: async (raw) => { const { id } = req(raw); invariant(typeof id === "string", "A computer update names the agent by its string id."); const force = req(raw).force === true; const result = req(await Promise.resolve(invoke(deps.boxRecovery, "recreateComputer", { preserveData: true, force }))); if (result.status !== "dev-fallback") return result; await Promise.resolve(invoke(deps.boxRecovery, "updateForeverBox", { id, force })); return { status: "dev-fallback-finished" }; },

    getWindowState: () => invoke(deps.windowChrome, "getWindowState"), minimizeWindow: () => { invoke(deps.windowChrome, "minimize"); }, toggleMaximizeWindow: () => { invoke(deps.windowChrome, "toggleMaximize"); }, closeWindow: () => { invoke(deps.windowChrome, "close"); },
    setTitleBarOverlayTone: (raw) => { invoke(deps.windowChrome, "setTitleBarOverlayTone", req(raw).isOverlayTone === true); },
    resizeWindowWidth: (raw) => { const delta = req(raw).deltaWidth; return typeof delta === "number" && Number.isFinite(delta) && delta !== 0 ? invoke(deps.windowChrome, "resizeWidth", delta) : 0; },
    pickAvatarSource: () => invoke(deps.avatarImages, "pickSource"), pickAvatarFile: () => invoke(deps.avatarImages, "pickFile"), generateAgentAvatarImage: (raw) => invoke(deps.avatarImages, "generateImage", req(raw).description),
    resolveAttachmentMedia: (raw) => invoke(deps.attachments, "resolveMedia", req(raw).source), readAttachmentText: (raw) => invoke(deps.attachments, "readText", req(raw).path), readAttachmentBytes: (raw) => invoke(deps.attachments, "readBytes", req(raw).path, req(raw).maxBytes), stageAttachmentBytes: (raw) => invoke(deps.attachments, "stageBytes", req(raw).filename, req(raw).bytes), downloadAttachment: (raw) => invoke(deps.attachments, "download", req(raw).path, req(raw).suggestedName), commitStagedAttachments: (raw) => invoke(deps.attachments, "commitStaged", req(raw).paths, req(raw).filenames), discardStagedAttachment: (raw) => invoke(deps.attachments, "discardStaged", req(raw).path), getLinkMetadata: (raw) => invoke(deps.attachments, "getLinkMetadata", req(raw).url),
    getCursorAuthStatus: () => invoke(deps.cursorAccount, "getAuthStatus"), loginCursor: () => invoke(deps.cursorAccount, "login"), cancelCursorLogin: () => invoke(deps.cursorAccount, "cancelLogin"), logoutCursor: () => invoke(deps.cursorAccount, "logout"), updateCursorAccountName: (raw) => invoke(deps.cursorAccount, "updateAccountName", req(raw).name), updateLocalProfile: (raw) => invoke(deps.cursorAccount, "updateLocalProfile", raw), getLocalProfile: async () => { const status = await Promise.resolve(invoke(deps.cursorAccount, "getAuthStatus")) as UnknownRecord; return { name: typeof status.displayName === "string" ? status.displayName : "Local", email: typeof status.email === "string" ? status.email : "", gravatarUrl: typeof status.profilePictureUrl === "string" ? status.profilePictureUrl : null }; }, getCursorAvatar: () => invoke(deps.cursorAccount, "getAvatar"), getCursorWeeklyUsage: () => invoke(deps.cursorAccount, "getWeeklyUsage"), getCursorUsageSummary: () => openRouterUsageSummary(deps), getCursorPrReviewPreferences: () => invoke(deps.cursorAccount, "getPrReviewPreferences"), getCursorPrivacyModeEnabled: () => invoke(deps.cursorAccount, "getPrivacyModeEnabled"), getSandAccess: () => invoke(deps.cursorAccount, "getSandAccess"), getSandAccessFresh: () => invoke(deps.cursorAccount, "getSandAccessFresh"), invokeCursorDashboardAction: (raw) => invoke(deps.cursorAccount, "invokeDashboardAction", raw), cancelCursorSandTrial: () => invoke(deps.cursorAccount, "cancelTrial"),
    transcribeAudio: async (raw) => { const request = req(raw); const audio = request.audio instanceof Uint8Array ? request.audio : request.audio instanceof ArrayBuffer ? new Uint8Array(request.audio) : null; invariant(audio != null && audio.length > 0, "transcribeAudio requires non-empty audio bytes."); const mimeType = typeof request.mimeType === "string" && request.mimeType.length > 0 ? request.mimeType : "audio/webm"; const language = typeof request.language === "string" && request.language.length > 0 ? request.language : undefined; const manager = await deps.ensureTranscriptionManager(); return await Promise.resolve(invoke(manager, "transcribe", { audio, mimeType, ...(language === undefined ? {} : { language }) })); },
    getExperimentsSnapshot: async () => invoke(req(await Promise.resolve(invoke(deps.experiments, "ensureService"))), "getSnapshot"),
    applyFeatureFlagOverride: async (raw) => { const service = req(await Promise.resolve(invoke(deps.experiments, "ensureService"))); invoke(service, "applyFeatureFlagOverrideCommand", req(raw).command); },
    refreshFeatureFlags: async () => { const service = req(await Promise.resolve(invoke(deps.experiments, "ensureService"))); await Promise.resolve(invoke(service, "refreshNow")); },
    startRpcTraceWindow: async () => { const service = req(await Promise.resolve(invoke(deps.experiments, "ensureService"))); const snapshot = req(invoke(service, "getSnapshot")); if (snapshot.featureFlags == null || invoke(deps.experiments, "isTelemetryDisabled") === true) return false; return invoke(deps.experiments, "startRpcTraceWindow"); },
  };
  for (const name of ["getDesktopEnvironment", "getSidebarCollapsed", "setSidebarCollapsed", "reportAgentLoad", "reportAccessBlocked", "reportAgentsUnreachable", "reportRecoveryAction", "reportRebuildLifecycle", "reportReconciliation", "reportBoxVisibility", "reportSendLatency", "reportSendAck", "reportReactionAck", "reportRenderTtfr", "reportRenderStream", "reportVncSession", "reportVncLiveness", "reportOpenComputer", "reportUpdatePrompt", "reportSigninGate", "reportOnboardingStep", "reportClientFailure", "listSecrets", "revealSecret", "upsertSecrets", "removeSecrets", "getMcpState", "getEffectivePlugins", "getMcpCatalog", "getMcpTeamPopularity", "getMcpPluginLogo", "installEntry", "updatePluginInstall", "removeMcpServer", "uninstallPlugin", "authenticateMcpServer", "renameMcpAccount", "removeMcpAccount", "setMcpCustomInstructions", "listMcpServerTools", "toggleMcpToolDisabled"]) handlers[name] = unserved;
  return handlers;
}

/** Exact `edgeFamily()("appWindow", ...)` stamp applied by every emitted group. */
export function createMainEdgeServedHandlers(deps: MainEdgeDeps): ServedMainEdgeHandlerMap {
  const handlers = createMainEdgeHandlers(deps);
  return Object.fromEntries(
    Object.entries(handlers).map(([name, run]) => [name, { trust: "appWindow", run }]),
  );
}
