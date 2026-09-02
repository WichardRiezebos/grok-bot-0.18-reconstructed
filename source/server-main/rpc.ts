import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isSandThemePreference } from "../shared/desktop.js";
import { isSandInferenceProvider } from "../shared/inference-router.js";
import { localProfilePictureUrl, resolveLocalProfile } from "../shared/local-profile.js";
import { isSandLocalToolPermission } from "../shared/local-tool-permission.js";
import { openRouterUsageToCursorSummary } from "../shared/openrouter-usage-summary.js";
import { fetchOpenRouterCatalog, readOpenRouterApiKey } from "../shared/node/openrouter-models.js";
import {
  composioApiKeyFrom,
  composioEffectivePlugins,
  composioToolkitFromServerIdentifier,
  createComposioToolkitAuthLink,
  invalidateComposioMarketplaceCatalogCache,
  isComposioInstalledRow,
  listComposioBackendServers,
  listComposioConnectedAccounts,
  listComposioMarketplaceCatalog,
  mergeInstalledMcpServers,
  parseComposioMarketplacePluginId,
  resetComposioCachesForTests,
  toInstalledComposioServerTools,
  toInstalledComposioServers,
} from "../shared/node/composio-mcp.js";
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
  resolveOpenRouterSummarizeModel,
} from "../shared/openrouter-models.js";
import { MAIN_METHOD_TABLE } from "../shared/rpc/main.js";
import { CLIENT_PERSISTENCE_CHANNELS } from "../shared/persistence.js";
import type { RuntimeConfig } from "./config.js";
import type { DebugState } from "./debug-log.js";
import { postGatewayCommand } from "./gateway-rpc.js";
import { loadSecrets, persistSecrets } from "./secrets-file.js";
import { DockerUnavailableError, unavailable } from "./unavailable.js";
import { createWebAttachmentHandlers, readAttachmentMediaBytes } from "./web-attachments.js";

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

  const persistenceValues = new Map<string, string>();
  let persistenceLoaded = false;
  const loadPersistenceValues = (path: string): Record<string, string> => {
    if (!persistenceLoaded) {
      for (const [key, value] of Object.entries(loadPersistence(path))) persistenceValues.set(key, value);
      persistenceLoaded = true;
    }
    return Object.fromEntries(persistenceValues);
  };
  const savePersistenceValues = (path: string, values: Record<string, string>): void => {
    persistenceValues.clear();
    for (const [key, value] of Object.entries(values)) persistenceValues.set(key, value);
    persistenceLoaded = true;
    savePersistence(path, values);
  };

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
  const attachments = createWebAttachmentHandlers(config);

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

  const gatewayInstalledServers = async (): Promise<unknown[]> => {
    try {
      const state = await postGatewayCommand(config, "listInstalledMcpServers", {});
      if (Array.isArray(state)) return state;
      const record = state != null && typeof state === "object" && !Array.isArray(state) ? state as JsonMap : null;
      return Array.isArray(record?.servers) ? record.servers : [];
    } catch (error) {
      debug.logs.push({ at: new Date().toISOString(), stream: "control", text: `listInstalledMcpServers ${error instanceof Error ? error.message : String(error)}` });
      return [];
    }
  };

  const localComposioInstalled = async () => {
    const apiKey = composioApiKeyFrom(process.env, loadSecrets(options.secretsPath));
    if (apiKey == null) {
      return {
        servers: [] as Record<string, unknown>[],
        backend: [] as Awaited<ReturnType<typeof listComposioBackendServers>>,
      };
    }
    const backend = await listComposioBackendServers(apiKey);
    return {
      servers: toInstalledComposioServers(backend),
      backend,
    };
  };

  const readComposioApiKey = () => composioApiKeyFrom(process.env, loadSecrets(options.secretsPath));

  const refreshComposioRuntime = () => {
    resetComposioCachesForTests();
    invalidateComposioMarketplaceCatalogCache();
  };

  const composioConnectedToolkits = async (): Promise<Set<string>> => {
    const apiKey = readComposioApiKey();
    if (apiKey == null) return new Set();
    const accounts = await listComposioConnectedAccounts(apiKey);
    return new Set(accounts.map((account) => account.toolkit));
  };

  const composioMarketplaceCatalog = async () => listComposioMarketplaceCatalog(readComposioApiKey());

  const composioAuthRedirect = async (toolkitSlug: string) => {
    const apiKey = readComposioApiKey();
    if (apiKey == null) {
      throw new Error("Add COMPOSIO_API_KEY in Settings → Router before connecting Composio apps.");
    }
    refreshComposioRuntime();
    return await createComposioToolkitAuthLink(apiKey, toolkitSlug, {
      callbackUrl: config.publicUrl,
      userId: "grok-bot",
    });
  };

  const mergedMcpState = async () => {
    const gateway = await gatewayInstalledServers();
    const local = await localComposioInstalled();
    return { servers: mergeInstalledMcpServers(gateway, local.servers) };
  };

  const snapshot = () => {
    const provider = settings.getInferenceProvider() === "cursor" ? "openrouter" : settings.getInferenceProvider();
    const model = resolveOpenRouterModel(settings.getOpenRouterModel());
    return {
      provider,
      model,
      computerModel: settings.getOpenRouterComputerModel() ?? null,
      summarizeModel: settings.getOpenRouterSummarizeModel() ?? null,
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
    resolveAttachmentMedia: (payload) => attachments.resolveAttachmentMedia(payload),
    readAttachmentText: (payload) => attachments.readAttachmentText(payload),
    readAttachmentBytes: (payload) => attachments.readAttachmentBytes(payload),
    stageAttachmentBytes: (payload) => attachments.stageAttachmentBytes(payload),
    downloadAttachment: () => stub("downloadAttachment", "Save to disk is unavailable in the Docker web runtime."),
    commitStagedAttachments: (payload) => attachments.commitStagedAttachments(payload),
    discardStagedAttachment: (payload) => attachments.discardStagedAttachment(payload),
    forceRecreateComputer: () => stub("forceRecreateComputer", "Reset the box container from your host instead."),
    updateComputer: async (payload) => {
      const record = payload as JsonMap;
      const id = record.id;
      if (typeof id !== "string" || id.length === 0) throw new Error("A computer update names the agent by its string id.");
      const force = record.force === true;
      try {
        const result = await postGatewayCommand(config, "updateForeverBox", { id, force });
        const started = typeof result === "object" && result != null && (result as JsonMap).started;
        if (started === false) {
          const reason = typeof (result as JsonMap).reason === "string" ? (result as JsonMap).reason : "the service declined the update";
          throw new Error(`Couldn't update the computer (${reason}). It is unchanged.`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Couldn't update the computer")) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Couldn't update the computer (${detail}). It is unchanged.`);
      }
      return { status: "dev-fallback-finished" };
    },
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
    setHostSidebarSections: (payload) => {
      const sections = (payload as JsonMap).sections;
      if (Array.isArray(sections)) {
        settings.setSidebarSections(sections as Parameters<SandSettingsStore["setSidebarSections"]>[0]);
      }
      return settings.load().sidebarSections ?? null;
    },
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
      if (Object.prototype.hasOwnProperty.call(record, "summarizeModel")) {
        const summarize = record.summarizeModel;
        if (summarize == null || summarize === "" || summarize === "__inherit__") settings.setOpenRouterSummarizeModel(undefined);
        else {
          const id = normalizeOpenRouterModelId(summarize);
          if (id !== undefined) settings.setOpenRouterSummarizeModel(id);
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
      const computerModel = resolveOpenRouterComputerModel(settings.getOpenRouterComputerModel());
      const summarizeModel = resolveOpenRouterSummarizeModel(settings.getOpenRouterSummarizeModel(), model);
      const apiKey = readOpenRouterApiKey(settings.settingsPath) ?? config.openRouterKey;
      try {
        const models = await fetchOpenRouterCatalog({ ...(apiKey === undefined ? {} : { apiKey }), currentId: [model, computerModel, summarizeModel] });
        return { model, computerModel, summarizeModel, models };
      } catch (error) {
        return {
          model,
          computerModel,
          summarizeModel,
          models: [{ id: model, name: model, recommended: model === DEFAULT_OPENROUTER_MODEL }],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    getBoxRuntime: () => ({ mode: "docker", status: { available: true, running: true, ready: true, containerName: "box", image: "sand-box", detail: "Compose box service." }, idleMs: 0, suspended: false }),
    setBoxRuntime: () => stub("setBoxRuntime", "The Docker web runtime owns the box. Stop the Compose project to change it."),
    setBoxAutoSuspendIdleMs: () => stub("setBoxAutoSuspendIdleMs", "The Docker web runtime owns the box."),
    suspendBox: () => stub("suspendBox", "The Docker web runtime owns the box."),
    resumeBox: () => stub("resumeBox", "The Docker web runtime owns the box."),
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
    upsertSecrets: async (payload) => {
      const entries = (payload as JsonMap).entries;
      const current = loadSecrets(options.secretsPath);
      if (typeof entries === "object" && entries != null && !Array.isArray(entries)) {
        for (const [key, value] of Object.entries(entries)) if (typeof value === "string") current[key] = value;
        persistSecrets(options.secretsPath, current);
      }
      let synced = false;
      try {
        await postGatewayCommand(config, "setBoxSecrets", { secrets: current });
        synced = true;
        refreshComposioRuntime();
        await postGatewayCommand(config, "refreshMcp", {}).catch(() => undefined);
      } catch (error) {
        debug.logs.push({ at: new Date().toISOString(), stream: "control", text: `setBoxSecrets ${error instanceof Error ? error.message : String(error)}` });
      }
      return { keys: Object.keys(current).sort(), synced };
    },
    removeSecrets: async (payload) => {
      const keys = (payload as JsonMap).keys;
      const current = loadSecrets(options.secretsPath);
      if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string") delete current[key];
      persistSecrets(options.secretsPath, current);
      let synced = false;
      try {
        await postGatewayCommand(config, "setBoxSecrets", { secrets: current });
        synced = true;
      } catch (error) {
        debug.logs.push({ at: new Date().toISOString(), stream: "control", text: `setBoxSecrets ${error instanceof Error ? error.message : String(error)}` });
      }
      return { keys: Object.keys(current).sort(), synced };
    },
    getMcpState: mergedMcpState,
    getEffectivePlugins: async () => {
      const [catalog, connected] = await Promise.all([composioMarketplaceCatalog(), composioConnectedToolkits()]);
      return composioEffectivePlugins(catalog, connected);
    },
    getMcpCatalog: composioMarketplaceCatalog,
    getMcpTeamPopularity: () => ({}),
    getMcpPluginLogo: (payload) => {
      const url = (payload as JsonMap).url;
      return typeof url === "string" && url.length > 0 ? url : null;
    },
    installEntry: async (payload) => {
      const entryId = (payload as JsonMap).id;
      if (typeof entryId !== "string") return stub("installEntry");
      const toolkitSlug = parseComposioMarketplacePluginId(entryId);
      if (toolkitSlug == null) return stub("installEntry");
      const auth = await composioAuthRedirect(toolkitSlug);
      const state = await mergedMcpState();
      return { ...state, authorizationUrl: auth.redirectUrl, serverName: auth.serverName };
    },
    updatePluginInstall: () => stub("updatePluginInstall"),
    removeMcpServer: () => stub("removeMcpServer"),
    uninstallPlugin: () => stub("uninstallPlugin"),
    authenticateMcpServer: async (payload) => {
      const record = payload as JsonMap;
      const serverId = typeof record.serverId === "string" ? record.serverId : "";
      const state = await mergedMcpState();
      const match = state.servers.find((row) => row != null && typeof row === "object" && String((row as JsonMap).id) === serverId);
      if (match == null || !isComposioInstalledRow(match)) return stub("authenticateMcpServer");
      const identifier = typeof (match as JsonMap).serverIdentifier === "string" ? (match as JsonMap).serverIdentifier as string : "";
      const toolkitSlug = composioToolkitFromServerIdentifier(identifier);
      const serverName = typeof (match as JsonMap).name === "string" ? (match as JsonMap).name as string : "Composio";
      const auth = await composioAuthRedirect(toolkitSlug);
      return { status: "started", authorizationUrl: auth.redirectUrl, serverName };
    },
    renameMcpAccount: () => stub("renameMcpAccount"),
    removeMcpAccount: () => stub("removeMcpAccount"),
    setMcpCustomInstructions: () => stub("setMcpCustomInstructions"),
    listMcpServerTools: async (payload) => {
      const record = payload != null && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonMap : {};
      const serverId = typeof record.serverId === "string" ? record.serverId : "";
      const gateway = await gatewayInstalledServers();
      const local = await localComposioInstalled();
      const merged = mergeInstalledMcpServers(gateway, local.servers);
      const match = merged.find((row) => row != null && typeof row === "object" && String((row as JsonMap).id) === serverId);
      if (local.backend.length > 0 && match != null && isComposioInstalledRow(match)) {
        const identifier = String((match as JsonMap).serverIdentifier ?? "");
        const servers = identifier.length === 0
          ? local.backend
          : local.backend.filter((server) => server.serverIdentifier === identifier);
        return toInstalledComposioServerTools(servers.length > 0 ? servers : local.backend);
      }
      try {
        const tools = await postGatewayCommand(config, "listMcpServerTools", payload ?? {});
        return Array.isArray(tools) ? tools : [];
      } catch (error) {
        debug.logs.push({ at: new Date().toISOString(), stream: "control", text: `listMcpServerTools ${error instanceof Error ? error.message : String(error)}` });
        return [];
      }
    },
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
    "sand:mcp-list": () => main.getMcpState!({}),
    "sand:mcp-effective-plugins": () => main.getEffectivePlugins!({}),
    "sand:mcp-catalog": () => main.getMcpCatalog!({}),
    "sand:mcp-team-popularity": () => main.getMcpTeamPopularity!({}),
    "sand:mcp-plugin-logo": (payload) => main.getMcpPluginLogo!(payload),
    "sand:mcp-install": async (payload) => {
      const record = payload != null && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonMap : {};
      const entryId = typeof record.entryId === "string" ? record.entryId : "";
      const result = await main.installEntry!({ id: entryId, ...(record.values == null ? {} : { values: record.values }) });
      return result;
    },
    "sand:mcp-update-plugin-install": () => stub("sand:mcp-update-plugin-install"),
    "sand:mcp-remove": () => stub("sand:mcp-remove"),
    "sand:mcp-uninstall-plugin": () => stub("sand:mcp-uninstall-plugin"),
    "sand:mcp-auth": async (payload) => {
      const record = payload != null && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonMap : {};
      return await main.authenticateMcpServer!({
        serverId: record.serverId,
        accountKey: record.accountKey,
        trigger: record.trigger,
      });
    },
    "sand:mcp-rename-account": () => stub("sand:mcp-rename-account"),
    "sand:mcp-remove-account": () => stub("sand:mcp-remove-account"),
    "sand:mcp-set-instructions": () => stub("sand:mcp-set-instructions"),
    "sand:mcp-list-server-tools": (payload) => main.listMcpServerTools!(payload),
    "sand:mcp-toggle-tool-disabled": () => stub("sand:mcp-toggle-tool-disabled"),
    [CLIENT_PERSISTENCE_CHANNELS.read]: (payload) => {
      const key = (payload as JsonMap).key;
      if (typeof key !== "string") return null;
      return loadPersistenceValues(options.persistencePath)[key] ?? null;
    },
    [CLIENT_PERSISTENCE_CHANNELS.write]: (payload) => {
      const record = payload as JsonMap;
      if (typeof record.key !== "string" || typeof record.value !== "string") return null;
      const values = loadPersistenceValues(options.persistencePath);
      values[record.key] = record.value;
      savePersistenceValues(options.persistencePath, values);
      return null;
    },
    [CLIENT_PERSISTENCE_CHANNELS.remove]: (payload) => {
      const key = (payload as JsonMap).key;
      if (typeof key !== "string") return null;
      const values = loadPersistenceValues(options.persistencePath);
      delete values[key];
      savePersistenceValues(options.persistencePath, values);
      return null;
    },
    [CLIENT_PERSISTENCE_CHANNELS.listKeys]: (payload) => {
      const prefix = (payload as JsonMap).prefix;
      const keys = Object.keys(loadPersistenceValues(options.persistencePath));
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
