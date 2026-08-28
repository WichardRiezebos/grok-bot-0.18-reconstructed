import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isSandThemePreference } from "../shared/desktop.js";
import { isSandInferenceProvider } from "../shared/inference-router.js";
import { localProfilePictureUrl, resolveLocalProfile } from "../shared/local-profile.js";
import { isSandLocalToolPermission } from "../shared/local-tool-permission.js";
import { openRouterUsageToCursorSummary } from "../shared/openrouter-usage-summary.js";
import { fetchOpenRouterCatalog, readOpenRouterApiKey } from "../shared/node/openrouter-models.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import {
  DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_REASONING_EFFORT,
  normalizeOpenRouterModelId,
  normalizeOpenRouterReasoningEffort,
  resolveOpenRouterComputerModel,
  resolveOpenRouterModel,
  resolveOpenRouterReasoningEffort,
} from "../shared/openrouter-models.js";
import { MAIN_METHOD_TABLE } from "../shared/rpc/main.js";
import { CLIENT_PERSISTENCE_CHANNELS } from "../shared/persistence.js";
import type { RuntimeConfig } from "./config.js";
import type { DebugState } from "./debug-log.js";
import { loadSecrets, persistSecrets } from "./secrets-file.js";
import { DockerUnavailableError, unavailable } from "./unavailable.js";

type JsonMap = Record<string, unknown>;

function loadPersistence(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function savePersistence(path: string, values: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function themeState(preference: string) {
  return { preference, resolved: preference === "system" ? "dark" : preference, source: "docker" };
}

export function createRpcDispatcher(options: {
  readonly config: RuntimeConfig;
  readonly debug: DebugState;
  readonly settings: SandSettingsStore;
  readonly secretsPath: string;
  readonly persistencePath: string;
  readonly restartCoordinator: () => void;
  readonly emit?: (event: string, payload: unknown) => void;
}): (channel: string, payload: unknown) => Promise<unknown> {
  const { config, debug, settings } = options;

  const stub = (method: string, detail = "Unavailable in the Docker web runtime.") => {
    debug.stubs.push({ at: new Date().toISOString(), method, detail });
    unavailable(method, detail);
  };

  const localProfile = () => {
    const profile = resolveLocalProfile({
      name: settings.getLocalProfileName(),
      email: settings.getLocalProfileEmail(),
    });
    const gravatarUrl = localProfilePictureUrl(profile.email);
    return { name: profile.name, email: profile.email, gravatarUrl: gravatarUrl ?? null };
  };
  const localAuth = () => {
    const profile = localProfile();
    return {
      kind: "logged-in",
      authId: "local",
      displayName: profile.name,
      ...(profile.email.length > 0 ? { email: profile.email } : {}),
      ...(profile.gravatarUrl != null ? { profilePictureUrl: profile.gravatarUrl } : {}),
    };
  };

  const snapshot = () => {
    const provider = settings.getInferenceProvider() === "cursor" ? "openrouter" : settings.getInferenceProvider();
    const model = resolveOpenRouterModel(settings.getOpenRouterModel());
    return {
      provider,
      model,
      computerModel: settings.getOpenRouterComputerModel() ?? null,
      reasoningEffort: resolveOpenRouterReasoningEffort(settings.getOpenRouterReasoningEffort(), DEFAULT_OPENROUTER_REASONING_EFFORT),
      computerReasoningEffort: resolveOpenRouterReasoningEffort(settings.getOpenRouterComputerReasoningEffort(), DEFAULT_OPENROUTER_COMPUTER_REASONING_EFFORT),
      usage: settings.getInferenceRouterUsage(),
      local: { "claude-code": { installed: false, authenticated: false, executablePath: null }, codex: { installed: false, authenticated: false, executablePath: null } },
    };
  };

  const main: Record<string, (payload: unknown) => unknown | Promise<unknown>> = {
    getDesktopEnvironment: () => ({ runtime: "docker", platform: process.platform, arch: process.arch, publicUrl: config.publicUrl }),
    getWindowState: () => ({ isMaximized: true, isFullscreen: false, isFullScreen: false, isFocused: true }),
    minimizeWindow: () => stub("minimizeWindow"),
    toggleMaximizeWindow: () => stub("toggleMaximizeWindow"),
    closeWindow: () => stub("closeWindow"),
    resizeWindowWidth: () => stub("resizeWindowWidth"),
    setTitleBarOverlayTone: () => null,
    getThemeState: () => themeState(settings.getThemePreference()),
    setThemePreference: (payload) => {
      const preference = (payload as JsonMap).preference;
      if (isSandThemePreference(preference)) settings.setThemePreference(preference);
      return themeState(settings.getThemePreference());
    },
    getEgressTunnelEnabled: () => false,
    setEgressTunnelEnabled: () => stub("setEgressTunnelEnabled"),
    getEgressTunnelStatus: () => ({ state: "off", relayedStreams: 0, activeStreams: 0 }),
    getWebauthnProxyEnabled: () => false,
    setWebauthnProxyEnabled: () => stub("setWebauthnProxyEnabled"),
    getUpdateStatus: () => ({
      state: { type: "disabled", reason: "disabled-by-env" },
      currentVersion: "0.18.0-reconstructed.1",
      currentTrack: "stable",
      trackOverride: null,
      buildDefaultTrack: "stable",
      availableTracks: ["stable"],
      isTrackManagedByPolicy: false,
      isBelowMinimumVersion: false,
      autoUpdateWhenIdleOptIn: false,
      autoUpdateWhenIdleGateEnabled: false,
    }),
    checkForUpdates: () => stub("checkForUpdates"),
    setUpdateTrack: () => stub("setUpdateTrack"),
    quitAndInstallUpdate: () => stub("quitAndInstallUpdate"),
    setAutoUpdateWhenIdleOptIn: () => false,
    getBoxMigrationStatus: () => ({ status: "idle" }),
    markDeepLinksReady: () => null,
    getOnboardingSeen: () => true,
    setOnboardingSeen: () => null,
    getTimeZone: () => ({ detectedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, overrideTimeZone: settings.getUserTimeZoneOverride() ?? null }),
    setTimeZoneOverride: (payload) => {
      const timeZone = (payload as JsonMap).timeZone;
      if (timeZone === null) settings.setUserTimeZoneOverride(undefined);
      else if (typeof timeZone === "string") settings.setUserTimeZoneOverride(timeZone);
      return { detectedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, overrideTimeZone: settings.getUserTimeZoneOverride() ?? null };
    },
    getAutoReviewInstructions: () => settings.getAutoReviewInstructions(),
    setAutoReviewInstructions: (payload) => {
      const instructions = (payload as JsonMap).instructions as Parameters<SandSettingsStore["setAutoReviewInstructions"]>[0];
      if (instructions != null) settings.setAutoReviewInstructions(instructions);
      return settings.getAutoReviewInstructions();
    },
    getLocalToolPermission: () => settings.getLocalToolPermission(),
    getLocalToolPermissionCeiling: () => settings.getLocalToolPermissionCeiling() ?? null,
    setLocalToolPermission: (payload) => {
      const permission = (payload as JsonMap).permission;
      if (isSandLocalToolPermission(permission)) settings.setLocalToolPermission(permission);
      return settings.getLocalToolPermission();
    },
    recordLocalToolApproval: () => null,
    clearLocalToolApprovals: () => null,
    getSidebarCollapsed: () => false,
    setSidebarCollapsed: () => false,
    pickAvatarSource: () => stub("pickAvatarSource"),
    pickAvatarFile: () => stub("pickAvatarFile"),
    generateAgentAvatarImage: () => stub("generateAgentAvatarImage"),
    resolveAttachmentMedia: () => stub("resolveAttachmentMedia"),
    readAttachmentText: () => stub("readAttachmentText"),
    readAttachmentBytes: () => stub("readAttachmentBytes"),
    stageAttachmentBytes: () => stub("stageAttachmentBytes"),
    downloadAttachment: () => stub("downloadAttachment"),
    commitStagedAttachments: () => stub("commitStagedAttachments"),
    discardStagedAttachment: () => stub("discardStagedAttachment"),
    forceRecreateComputer: () => stub("forceRecreateComputer", "Reset the box container from your host instead."),
    updateComputer: () => stub("updateComputer"),
    forceReconnectGateway: () => { options.restartCoordinator(); return null; },
    getExperimentsSnapshot: () => ({ flags: {}, runtime: "docker" }),
    applyFeatureFlagOverride: () => stub("applyFeatureFlagOverride"),
    refreshFeatureFlags: () => ({ flags: {}, runtime: "docker" }),
    startRpcTraceWindow: () => false,
    getAgentDefaultModel: () => settings.getAgentDefaultModel() ?? null,
    setAgentDefaultModel: (payload) => {
      const model = (payload as JsonMap).model;
      settings.setAgentDefaultModel(model as never);
      return settings.getAgentDefaultModel() ?? null;
    },
    getComputerUseModel: () => settings.getComputerUseModel() ?? null,
    setComputerUseModel: (payload) => {
      const model = (payload as JsonMap).model;
      settings.setComputerUseModel(model == null ? undefined : model as never);
      return settings.getComputerUseModel() ?? null;
    },
    getHostPinnedAgents: () => settings.load().pinnedAgentIds ?? null,
    setHostPinnedAgents: (payload) => {
      const ids = (payload as JsonMap).pinnedAgentIds;
      if (Array.isArray(ids)) settings.persist({ ...settings.load(), pinnedAgentIds: ids.filter((id): id is string => typeof id === "string") });
      return settings.load().pinnedAgentIds ?? null;
    },
    getHostSidebarSections: () => settings.load().sidebarSections ?? null,
    setHostSidebarSections: (payload) => (payload as JsonMap).sections ?? settings.load().sidebarSections ?? null,
    getAvailableModels: () => [],
    getInferenceRouter: () => snapshot(),
    setInferenceRouter: (payload) => {
      const record = payload as JsonMap;
      const provider = record.provider;
      if (isSandInferenceProvider(provider)) settings.setInferenceProvider(provider === "cursor" ? "openrouter" : provider);
      const model = normalizeOpenRouterModelId(record.model);
      if (model !== undefined) settings.setOpenRouterModel(model);
      if (Object.prototype.hasOwnProperty.call(record, "computerModel")) {
        const computer = record.computerModel;
        if (computer == null || computer === "" || computer === "__inherit__") settings.setOpenRouterComputerModel(undefined);
        else {
          const id = normalizeOpenRouterModelId(computer);
          if (id !== undefined) settings.setOpenRouterComputerModel(id);
        }
      }
      const effort = normalizeOpenRouterReasoningEffort(record.reasoningEffort);
      if (effort !== undefined) settings.setOpenRouterReasoningEffort(effort);
      const computerEffort = normalizeOpenRouterReasoningEffort(record.computerReasoningEffort);
      if (computerEffort !== undefined) settings.setOpenRouterComputerReasoningEffort(computerEffort);
      return snapshot();
    },
    listOpenRouterModels: async () => {
      const model = resolveOpenRouterModel(settings.getOpenRouterModel());
      const computerModel = resolveOpenRouterComputerModel(settings.getOpenRouterComputerModel(), model);
      const apiKey = readOpenRouterApiKey(settings.settingsPath) ?? config.openRouterKey;
      try {
        const models = await fetchOpenRouterCatalog({ ...(apiKey === undefined ? {} : { apiKey }), currentId: [model, computerModel] });
        return { model, computerModel, models };
      } catch (error) {
        return {
          model,
          computerModel,
          models: [{ id: model, name: model, recommended: model === DEFAULT_OPENROUTER_MODEL }],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    getBoxRuntime: () => ({ mode: "docker", status: { available: true, running: true, ready: true, containerName: "box", image: "sand-box", detail: "Compose box service." } }),
    setBoxRuntime: () => stub("setBoxRuntime", "The Docker web runtime owns the box. Stop the Compose project to change it."),
    transcribeAudio: () => stub("transcribeAudio"),
    getCursorAuthStatus: () => localAuth(),
    loginCursor: () => localAuth(),
    cancelCursorLogin: () => localAuth(),
    logoutCursor: () => localAuth(),
    updateCursorAccountName: (payload) => {
      const name = (payload as JsonMap).name;
      if (typeof name === "string") settings.setLocalProfileName(name);
      const status = localAuth();
      options.emit?.("cursor-auth-changed", status);
      return status;
    },
    updateLocalProfile: (payload) => {
      const record = payload as JsonMap;
      if (typeof record.name === "string") settings.setLocalProfileName(record.name);
      if (typeof record.email === "string") settings.setLocalProfileEmail(record.email);
      const status = localAuth();
      options.emit?.("cursor-auth-changed", status);
      return status;
    },
    getLocalProfile: () => localProfile(),
    getCursorAvatar: () => localProfile().gravatarUrl,
    getCursorWeeklyUsage: () => null,
    getCursorUsageSummary: () => openRouterUsageToCursorSummary(settings.getInferenceRouterUsage()),
    getCursorPrReviewPreferences: () => null,
    getCursorPrivacyModeEnabled: () => false,
    getSandAccess: () => ({ state: "granted", reason: "none" }),
    getSandAccessFresh: () => ({ state: "granted", reason: "none" }),
    invokeCursorDashboardAction: () => stub("invokeCursorDashboardAction"),
    cancelCursorSandTrial: () => stub("cancelCursorSandTrial"),
    reportAgentLoad: () => null,
    reportAccessBlocked: () => null,
    reportAgentsUnreachable: () => null,
    reportRecoveryAction: () => null,
    reportRebuildLifecycle: () => null,
    reportReconciliation: () => null,
    reportBoxVisibility: () => null,
    reportSendLatency: () => null,
    reportSendAck: () => null,
    reportReactionAck: () => null,
    reportRenderTtfr: () => null,
    reportRenderStream: () => null,
    reportVncSession: () => null,
    reportVncLiveness: () => null,
    reportOpenComputer: () => null,
    reportUpdatePrompt: () => null,
    reportSigninGate: () => null,
    reportOnboardingStep: () => null,
    reportClientFailure: () => null,
    openCloudAgent: () => stub("openCloudAgent"),
    getLinkMetadata: () => ({ title: null, description: null }),
    openExternal: (payload) => {
      const url = (payload as JsonMap).url;
      if (typeof url === "string") debug.logs.push({ at: new Date().toISOString(), stream: "control", text: `openExternal ${url}` });
      return null;
    },
    submitFeedback: () => stub("submitFeedback"),
    listSecrets: () => ({ keys: Object.keys(loadSecrets(options.secretsPath)).sort() }),
    revealSecret: (payload) => {
      const key = (payload as JsonMap).key;
      if (typeof key !== "string") return { value: null };
      return { value: loadSecrets(options.secretsPath)[key] ?? null };
    },
    upsertSecrets: (payload) => {
      const entries = (payload as JsonMap).entries;
      const current = loadSecrets(options.secretsPath);
      if (typeof entries === "object" && entries != null && !Array.isArray(entries)) {
        for (const [key, value] of Object.entries(entries)) if (typeof value === "string") current[key] = value;
        persistSecrets(options.secretsPath, current);
      }
      return { keys: Object.keys(current).sort(), synced: true };
    },
    removeSecrets: (payload) => {
      const keys = (payload as JsonMap).keys;
      const current = loadSecrets(options.secretsPath);
      if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string") delete current[key];
      persistSecrets(options.secretsPath, current);
      return { keys: Object.keys(current).sort() };
    },
    getMcpState: () => ({ servers: [] }),
    getEffectivePlugins: () => [],
    getMcpCatalog: () => [],
    getMcpTeamPopularity: () => [],
    getMcpPluginLogo: () => null,
    installEntry: () => stub("installEntry"),
    updatePluginInstall: () => stub("updatePluginInstall"),
    removeMcpServer: () => stub("removeMcpServer"),
    uninstallPlugin: () => stub("uninstallPlugin"),
    authenticateMcpServer: () => stub("authenticateMcpServer"),
    renameMcpAccount: () => stub("renameMcpAccount"),
    removeMcpAccount: () => stub("removeMcpAccount"),
    setMcpCustomInstructions: () => stub("setMcpCustomInstructions"),
    listMcpServerTools: () => [],
    toggleMcpToolDisabled: () => stub("toggleMcpToolDisabled"),
  };

  for (const method of Object.keys(MAIN_METHOD_TABLE)) {
    if (main[method] == null) main[method] = () => stub(method);
  }

  const ipc: Record<string, (payload: unknown) => unknown | Promise<unknown>> = {
    "sand:secrets-list": () => main.listSecrets!({}),
    "sand:secrets-reveal": (payload) => main.revealSecret!(payload),
    "sand:secrets-upsert": (payload) => main.upsertSecrets!(payload),
    "sand:secrets-delete": (payload) => main.removeSecrets!(payload),
    "sand:mcp-list": () => ({ servers: [] }),
    "sand:mcp-effective-plugins": () => [],
    "sand:mcp-catalog": () => [],
    "sand:mcp-team-popularity": () => [],
    "sand:mcp-plugin-logo": () => null,
    "sand:mcp-install": () => stub("sand:mcp-install"),
    "sand:mcp-update-plugin-install": () => stub("sand:mcp-update-plugin-install"),
    "sand:mcp-remove": () => stub("sand:mcp-remove"),
    "sand:mcp-uninstall-plugin": () => stub("sand:mcp-uninstall-plugin"),
    "sand:mcp-auth": () => stub("sand:mcp-auth"),
    "sand:mcp-rename-account": () => stub("sand:mcp-rename-account"),
    "sand:mcp-remove-account": () => stub("sand:mcp-remove-account"),
    "sand:mcp-set-instructions": () => stub("sand:mcp-set-instructions"),
    "sand:mcp-list-server-tools": () => [],
    "sand:mcp-toggle-tool-disabled": () => stub("sand:mcp-toggle-tool-disabled"),
    [CLIENT_PERSISTENCE_CHANNELS.read]: (payload) => {
      const key = (payload as JsonMap).key;
      if (typeof key !== "string") return null;
      return loadPersistence(options.persistencePath)[key] ?? null;
    },
    [CLIENT_PERSISTENCE_CHANNELS.write]: (payload) => {
      const record = payload as JsonMap;
      if (typeof record.key !== "string" || typeof record.value !== "string") return null;
      const values = loadPersistence(options.persistencePath);
      values[record.key] = record.value;
      savePersistence(options.persistencePath, values);
      return null;
    },
    [CLIENT_PERSISTENCE_CHANNELS.remove]: (payload) => {
      const key = (payload as JsonMap).key;
      if (typeof key !== "string") return null;
      const values = loadPersistence(options.persistencePath);
      delete values[key];
      savePersistence(options.persistencePath, values);
      return null;
    },
    [CLIENT_PERSISTENCE_CHANNELS.listKeys]: (payload) => {
      const prefix = (payload as JsonMap).prefix;
      const keys = Object.keys(loadPersistence(options.persistencePath));
      return typeof prefix === "string" ? keys.filter((key) => key.startsWith(prefix)) : keys;
    },
    [CLIENT_PERSISTENCE_CHANNELS.migrate]: () => null,
  };

  return async (channel, payload) => {
    const started = Date.now();
    const method = channel.startsWith("sand-rpc:main:m:") ? channel.slice("sand-rpc:main:m:".length) : channel;
    try {
      const handler = channel.startsWith("sand-rpc:main:m:") ? main[method] : ipc[channel] ?? main[method];
      if (handler == null) throw new DockerUnavailableError(method, `No handler for ${channel}`);
      const value = await handler(payload ?? {});
      debug.rpc.push({ at: new Date().toISOString(), method, durationMs: Date.now() - started, ok: true });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug.rpc.push({ at: new Date().toISOString(), method, durationMs: Date.now() - started, ok: false, error: message });
      throw error;
    }
  };
}

export function initialRendererState(settings: SandSettingsStore) {
  return {
    experimentSnapshot: { flags: {}, runtime: "docker" },
    themeState: themeState(settings.getThemePreference()),
    egressTunnelEnabled: false,
    webauthnProxyEnabled: false,
    egressTunnelStatus: { state: "off", relayedStreams: 0, activeStreams: 0 },
  };
}
