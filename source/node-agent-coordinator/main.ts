import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import { createRealExpiryPolicy, createRealPollingPolicy, createRealRetryPolicy, realClock } from "../internal/scheduling.js";
import { COORDINATOR_TRANSPORT_STATE_FAMILY, COORDINATOR_UNKNOWN_METHOD, type CoordinatorReplyOutcome } from "../shared/rpc/coordinator-port.js";
import { isCoordinatorMainMethod } from "../shared/rpc/coordinator-main.js";
import { SAND_WEBAUTHN_HEARTBEAT_INTERVAL_MS, type WebAuthnCeremony } from "../shared/webauthn-gateway.js";
import { adoptCarrier, type CarrierIntake } from "./carrier.js";
import { createControlPortClient } from "./control-port-client.js";
import { CoordinatorGatewayClient, HOST_ACCOUNT_SLOT, createCoordinatorGatewayClientTiming, type GatewayConnection } from "./gateway/gateway-client.js";
import { createGatewayDnsDiagnosticReporter } from "./gateway/gateway-dns-diagnostics.js";
import { coordinatorEventFamilyForSseChannel } from "./gateway/gateway-event-families.js";
import { createGatewayRequestDispatch, failureFor } from "./gateway/gateway-request-dispatcher.js";
import { SandHostSupervisor, createCoordinatorHostSupervisorTiming } from "./gateway/host-supervisor.js";
import { createLocalExecDaemonRefreshPolicy, createLocalExecDaemonSupervisor } from "./local-exec/supervisor.js";
import { McpOAuthForwarder } from "./oauth/mcp-oauth-forwarder.js";
import { createRendererPortServer } from "./renderer-port-server.js";
import { createTransportStageRecorder } from "./telemetry/transport-stage-recorder.js";
import { createWebAuthnProvider } from "./webauthn/provider.js";
import { createSpawnedWebAuthnSigner, resolveWebAuthnSignerPath } from "./webauthn/signer.js";
import { ClientSideToolV2Relay } from "./client-side-tool-v2-relay.js";
import { createCoordinatorInferenceRouter } from "./inference-router.js";
import { setEnforceRedactionGate } from "../packages/redaction/privacy-context.js";
import { setRedactionLogger } from "../packages/redaction/types.js";

export interface McpOAuthPending {
  readonly serverName: string;
  readonly redirectUrl: string;
  readonly state: string;
}

export function asMcpOAuthPending(payload: unknown): McpOAuthPending | null {
  if (typeof payload !== "object" || payload == null) return null;
  const { serverName, redirectUrl, state } = payload as Record<string, unknown>;
  if (typeof serverName !== "string" || serverName.length === 0) return null;
  if (typeof redirectUrl !== "string" || redirectUrl.length === 0) return null;
  if (typeof state !== "string" || state.length === 0) return null;
  return { serverName, redirectUrl, state };
}

export function recordEchoIfUserEcho(payload: unknown, recorder: { recordSendEcho(key: { accountSlot: string; clientNonce: string }): void }): void {
  if (typeof payload !== "object" || payload == null) return;
  const event = payload as { readonly type?: unknown; readonly entry?: Record<string, unknown> };
  if (event.type !== "appended") return;
  const entry = event.entry;
  if (typeof entry?.clientNonce !== "string" || entry.clientNonce.length === 0) return;
  const isUserEcho = (entry.kind === "message" && entry.role === "user") || entry.kind === "user-attachment";
  if (isUserEcho) recorder.recordSendEcho({ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: entry.clientNonce });
}

export function createWebAuthnReconnectPolicy() {
  return createRealRetryPolicy({ name: "sand-webauthn-reconnect", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 });
}

type Commands = Record<string, (args: unknown) => Promise<unknown>>;

function command<T>(commands: Commands, method: string, args: unknown): Promise<T> {
  const invoke = commands[method];
  if (invoke === undefined) return Promise.reject(new Error(`control command ${method} is unavailable`));
  return invoke(args) as Promise<T>;
}

export interface ComposeCoordinatorDependencies {
  readonly adoptCarrier?: () => Promise<CarrierIntake>;
  readonly resolveSignerPath?: typeof resolveWebAuthnSignerPath;
}

export async function composeCoordinator(dependencies: ComposeCoordinatorDependencies = {}): Promise<void> {
  setRedactionLogger({ info(attributes, message) { console.info(message, attributes); } });
  setEnforceRedactionGate(() => process.env.NODE_ENV !== "development" && process.env.VITEST !== "true");
  const carrierIntake = await (dependencies.adoptCarrier ?? adoptCarrier)();
  if (!carrierIntake.adopted) {
    process.stderr.write(`node-agent-coordinator: ${carrierIntake.rejection.detail}\n`);
    process.exit(2);
  }
  const carrier = carrierIntake.carrier;
  const bootstrap = carrier.bootstrap;
  const controlClient = createControlPortClient({ post: (frame) => carrier.control.post(frame), close: () => carrier.control.close() });
  const commands = controlClient.commands;
  const recorder = createTransportStageRecorder({
    clock: realClock,
    egress: {
      reportTransportStage: (report) => command(commands, "reportTransportStage", report),
      reportGatewayCommandSpan: (report) => command(commands, "reportGatewayCommandSpan", report),
      reportGatewayReachability: (report) => command(commands, "reportGatewayReachability", report),
      reportGatewayDnsDiagnostic: (report) => command(commands, "reportGatewayDnsDiagnostic", report)
    }
  });
  const dnsDiagnostics = createGatewayDnsDiagnosticReporter((report) => recorder.recordGatewayDnsDiagnostic(report));
  const reportReachability = (report: unknown, baseUrl?: string) => {
    recorder.recordGatewayReachability(report);
    dnsDiagnostics.observe(report as { outcome: string; causeSummary?: string }, baseUrl);
  };
  let isGatewayStreamLive = false;
  const hostSupervisor = new SandHostSupervisor({
    resolveGatewayConnection: () => command(commands, "resolveGatewayConnection", {}),
    timing: createCoordinatorHostSupervisorTiming(),
    isTransportLive: () => isGatewayStreamLive,
    onReachability: reportReachability
  });
  const GATEWAY_KEEP_WARM_INTERVAL_MS = 4_000;
  const keepWarmTimer = setInterval(() => {
    if (isGatewayStreamLive) return;
    void hostSupervisor.refreshCachedConnectionHealth();
  }, GATEWAY_KEEP_WARM_INTERVAL_MS);
  keepWarmTimer.unref?.();
  const oauthPendingHandlers = new Set<(pending: McpOAuthPending) => void>();
  let server: ReturnType<typeof createRendererPortServer>;
  let localExecSupervisor: ReturnType<typeof createLocalExecDaemonSupervisor>;
  const toolRelay = new ClientSideToolV2Relay((family, payload) => server.postEvent(family, payload));
  let overlayAgentsEvent: (payload: unknown) => unknown = payload => payload;

  function handleGatewaySseEvent(event: { channel: string; payload: unknown }): void {
    if (event.channel === "mcp-oauth-pending") {
      const pending = asMcpOAuthPending(event.payload);
      if (pending != null) for (const handler of oauthPendingHandlers) handler(pending);
      return;
    }
    if (event.channel === "transcript") recordEchoIfUserEcho(event.payload, recorder);
    if (event.channel === "client-side-tool-v2") {
      toolRelay.accept(event.payload);
      return;
    }
    const shouldOverlayRoster = event.channel === "agents" || event.channel === "agent-upserted";
    const rosterPayload = shouldOverlayRoster ? overlayAgentsEvent(event.payload) : event.payload;
    if (event.channel === "agents") controlClient.postEvent("agents-event", { kind: "agents", event: rosterPayload });
    if (event.channel === "agent-upserted") controlClient.postEvent("agents-event", { kind: "agent-upserted", event: rosterPayload });
    const family = coordinatorEventFamilyForSseChannel(event.channel);
    if (family != null) server.postEvent(family, shouldOverlayRoster ? rosterPayload : event.payload);
  }

  async function seedAgentsRosterToMain(): Promise<void> {
    try {
      const agents = overlayAgentsEvent({ agents: await gatewayClient.dispatchCommand("listAgents", {}) });
      controlClient.postEvent("agents-roster-seed", { agents: (agents as { agents?: unknown }).agents ?? agents });
    } catch (error) {
      process.stderr.write(`node-agent-coordinator: agents roster seed skipped: ${String(error)}\n`);
    }
  }

  function handleTransportEvent(raw: unknown): void {
    if (typeof raw !== "object" || raw == null) return;
    const event = raw as { family: string; payload: unknown };
    controlClient.postEvent(event.family, event.payload);
    if (event.family === "transport-down") {
      isGatewayStreamLive = false;
      hostSupervisor.invalidateHealthCache();
      void hostSupervisor.refreshCachedConnectionHealth();
      server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" });
      return;
    }
    isGatewayStreamLive = true;
    void localExecSupervisor.refreshConnection();
    void seedAgentsRosterToMain();
    server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "connected" });
  }

  const gatewayClient = new CoordinatorGatewayClient({
    resolveConnection: (signal, options) => options?.demand === true
      ? command(commands, "resolveGatewayConnection", { demand: true }) as Promise<GatewayConnection>
      : hostSupervisor.ensureConnection(signal) as Promise<GatewayConnection>,
    onEvent: handleGatewaySseEvent,
    onTransportEvent: handleTransportEvent,
    onTransportRetry: () => hostSupervisor.invalidateHealthCache(),
    recordTransportStage: (report) => recorder.recordTransportStage(report as Parameters<typeof recorder.recordTransportStage>[0]),
    onReachability: reportReachability,
    resolveTraceWindowTraceparent: () => command(commands, "getRpcTraceWindowTraceparent", {}),
    recordGatewayCommandSpan: (report) => recorder.recordGatewayCommandSpan(report),
    timing: createCoordinatorGatewayClientTiming()
  });

  const oauthForwarder = new McpOAuthForwarder({
    pendingEvents: {
      subscribe(handler) {
        oauthPendingHandlers.add(handler);
        return { dispose() { oauthPendingHandlers.delete(handler); } };
      }
    },
    completion: { completeMcpOAuth: (args) => gatewayClient.dispatchLegacyCommand("completeMcpOAuth", args) },
    log: { warn(warning) { process.stderr.write(`node-agent-coordinator: mcp-oauth ${JSON.stringify(warning)}\n`); } },
    pendingExpiry: createRealExpiryPolicy({ name: "mcp-oauth-pending", ttlMs: 10 * 60_000 })
  });

  localExecSupervisor = createLocalExecDaemonSupervisor({
    control: {
      resolveGatewayConnection: (args) => command(commands, "resolveGatewayConnection", args),
      mintLocalExecDaemonCredential: (args) => command(commands, "mintLocalExecDaemonCredential", args),
      spawnLocalExecDaemon: (args) => command(commands, "spawnLocalExecDaemon", args),
      isProcessAlive: (args) => command(commands, "isProcessAlive", args),
      getProcessIdentity: (args) => command(commands, "getProcessIdentity", args),
      waitLocalExecDaemonExit: (args) => command(commands, "waitLocalExecDaemonExit", args),
      terminateProcess: (args) => command(commands, "terminateProcess", args)
    },
    dataDir: bootstrap.processConfig.dataDir,
    isPackaged: bootstrap.processConfig.isPackaged,
    refreshPolicy: createLocalExecDaemonRefreshPolicy()
  });

  let webauthnProvider: ReturnType<typeof createWebAuthnProvider> | undefined;
  const signerPath = (dependencies.resolveSignerPath ?? resolveWebAuthnSignerPath)({ isPackaged: bootstrap.processConfig.isPackaged });
  if (signerPath !== undefined) {
    const reportProgress = (status: string) => { void command(commands, "updateWebAuthnConsent", { status }); };
    webauthnProvider = createWebAuthnProvider({
      resolveConnection: () => command(commands, "resolveGatewayConnection", {}),
      consent: {
        requestConsent: async (ceremony: WebAuthnCeremony) => {
          const optionsJson = ceremony.optionsJson;
          const options = typeof optionsJson === "string" ? JSON.parse(optionsJson) as { rpId?: string; rp?: { id?: string } } : {};
          return await command(commands, "requestWebAuthnConsent", { origin: ceremony.origin, rpId: options.rpId ?? options.rp?.id ?? ceremony.origin });
        },
        finish: () => { void command(commands, "finishWebAuthnConsent", {}); }
      },
      signer: createSpawnedWebAuthnSigner({
        binaryPath: signerPath,
        onStatus: reportProgress,
        onPinRequest: async (request, promptId) => {
          const result = await command<{ pin?: string | null }>(commands, "requestWebAuthnPin", { promptId, invalid: request.invalid, ...(request.retries === undefined ? {} : { retries: request.retries }) });
          return result.pin ?? undefined;
        }
      }),
      heartbeatPolicy: createRealPollingPolicy({ name: "sand-webauthn-heartbeat", intervalMs: SAND_WEBAUTHN_HEARTBEAT_INTERVAL_MS }),
      reconnectPolicy: createWebAuthnReconnectPolicy(),
      deliveryPolicy: createRealRetryPolicy({ name: "sand-webauthn-delivery", maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 4_000, jitterRatio: 0.2 }),
      label: hostname()
    });
    webauthnProvider.start();
  }

  const gatewayDispatch = createGatewayRequestDispatch(gatewayClient);
  const inferenceRouter = createCoordinatorInferenceRouter({
    dataDir: bootstrap.processConfig.dataDir,
    // Tunable turn-start window (ms); kept small so turns feel immediate.
    ...(Number.parseInt(process.env.SAND_ROUTED_COMPOSING_DELAY_MS ?? "", 10) > 0
      ? { composingDelayMs: Number.parseInt(process.env.SAND_ROUTED_COMPOSING_DELAY_MS ?? "", 10) }
      : {}),
    postEvent: (family, payload) => {
      const rosterPayload = family === "agents" || family === "agent-upserted" ? overlayAgentsEvent(payload) : payload;
      server.postEvent(family, rosterPayload);
    },
    dispatchRemote: (method, args) => method === "listRoutedMcpTools"
      ? command(commands, "listRoutedMcpTools", args)
      : method === "executeRoutedMcpTool"
        ? command(commands, "executeRoutedMcpTool", args)
        : gatewayClient.dispatchCommand(method, args),
  });
  overlayAgentsEvent = payload => inferenceRouter.overlayAgents(payload);
  const dispatchRequest = async (method: string, args: unknown, signal: AbortSignal) => {
    if (method === "sendPrompt" && typeof args === "object" && args != null) {
      const { clientNonce, traceparent } = args as Record<string, unknown>;
      recorder.beginSend({ accountSlot: HOST_ACCOUNT_SLOT, clientNonce: typeof clientNonce === "string" ? clientNonce : null, traceparent: typeof traceparent === "string" ? traceparent : null });
    }
    try {
      const routed = await inferenceRouter.dispatch(method, args);
      return routed.handled ? { status: "ok" as const, value: routed.value } : await gatewayDispatch(method, args, signal);
    } catch (error) {
      return { status: "failed" as const, failure: failureFor(error) };
    }
  };
  server = createRendererPortServer(
    { post: (frame) => carrier.data.post(frame), close: () => carrier.data.close() },
    { dispatchRequest, onServing: () => { toolRelay.replay(); if (!isGatewayStreamLive) server.postEvent(COORDINATOR_TRANSPORT_STATE_FAMILY, { state: "down" }); } }
  );
  const mainDispatch = createGatewayRequestDispatch(gatewayClient, isCoordinatorMainMethod);
  const applyPause = (paused: boolean) => {
    void localExecSupervisor.setPaused(paused);
    if (paused) webauthnProvider?.stop(); else webauthnProvider?.start();
  };
  const mainServer = createRendererPortServer(
    { post: (frame) => carrier.mainData.post(frame), close: () => carrier.mainData.close() },
    { dispatchRequest: (method, args, signal) => {
      if (method === "setGatewayPaused" && typeof args === "object" && args != null) applyPause((args as Record<string, unknown>).paused === true);
      return mainDispatch(method, args, signal);
    } }
  );

  let exitSettled = false;
  function formatPortSettlement(port: "renderer-data" | "renderer-main" | "control", settlement: { readonly outcome: string; readonly detail?: string; readonly reason?: string }): string {
    const detail = settlement.detail != null && settlement.detail.length > 0 ? ` (${settlement.detail})` : "";
    const reason = settlement.reason != null && settlement.reason.length > 0 ? ` reason=${settlement.reason}` : "";
    return `${port} ${settlement.outcome}${reason}${detail}`;
  }
  function settleProcess(exitCode: number, source: string): void {
    if (exitSettled) return;
    exitSettled = true;
    process.stderr.write(`node-agent-coordinator: settleProcess exit=${exitCode} source=${source}\n`);
    gatewayClient.close();
    toolRelay.clear();
    localExecSupervisor.dispose();
    oauthForwarder.dispose();
    controlClient.shutdown();
    server.handlePortClosed();
    mainServer.handlePortClosed();
    carrier.control.close(); carrier.data.close(); carrier.mainData.close();
    carrier.exitProcess(exitCode);
  }
  void server.settled.then((settlement) => {
    const label = formatPortSettlement("renderer-data", settlement);
    if (settlement.outcome === "protocol-breach") { process.stderr.write(`node-agent-coordinator: protocol breach: ${label}\n`); settleProcess(1, label); }
    else settleProcess(0, label);
  });
  void mainServer.settled.then((settlement) => {
    const label = formatPortSettlement("renderer-main", settlement);
    if (settlement.outcome === "protocol-breach") { process.stderr.write(`node-agent-coordinator: main-data protocol breach: ${label}\n`); settleProcess(1, label); }
    else settleProcess(0, label);
  });
  void controlClient.settled.then((settlement) => {
    const label = formatPortSettlement("control", settlement);
    if (settlement.outcome === "protocol-breach") { process.stderr.write(`node-agent-coordinator: control protocol breach: ${label}\n`); settleProcess(1, label); }
    else settleProcess(0, label);
  });
  const reportCrash = (kind: "uncaughtException" | "unhandledRejection", error: Error): void => {
    process.stderr.write(`node-agent-coordinator: ${kind}: ${error.stack ?? String(error)}\n`);
    void command(commands, "reportProcessCrash", { kind, errorName: error.name, errorMessage: error.message, errorStack: error.stack ?? null })
      .catch((reportError) => process.stderr.write(`node-agent-coordinator: crash report undelivered: ${String(reportError)}\n`));
  };
  process.on("uncaughtException", (value) => {
    reportCrash("uncaughtException", value instanceof Error ? value : new Error(String(value)));
    settleProcess(1, "uncaughtException");
  });
  // A leaked rejection (e.g. a turn aborted at its deadline while a tool call
  // was still settling) must not take down the coordinator and every bot's
  // in-flight turn with it — log it and keep serving.
  process.on("unhandledRejection", (value) => {
    reportCrash("unhandledRejection", value instanceof Error ? value : new Error(String(value)));
  });
  carrier.bind({
    onControlFrame: (frame) => controlClient.handleMessage(frame),
    // Debug probes bypass the renderer-port protocol entirely: a bare request
    // frame served by the port server before its hello handshake would breach
    // the protocol and take the coordinator down.
    onDataFrame: (value) => {
      const record = value as { kind?: unknown; requestId?: unknown; method?: unknown; args?: unknown } | null;
      if (record != null && record.kind === "request" && typeof record.requestId === "string"
        && typeof record.method === "string" && record.method.startsWith("debug-rpc:")) {
        const method = record.method.slice("debug-rpc:".length);
        void Promise.resolve()
          .then(() => {
            if (method !== "getRoutedDebug") throw new Error(`no debug method named ${method}`);
            return inferenceRouter.debugSnapshot();
          })
          .then(
            (snapshot): CoordinatorReplyOutcome => ({ status: "ok", value: snapshot }),
            (error: unknown): CoordinatorReplyOutcome => ({ status: "failed", failure: { code: COORDINATOR_UNKNOWN_METHOD, message: error instanceof Error ? error.message : String(error) } }),
          )
          .then((outcome) => carrier.data.post({ kind: "reply", requestId: record.requestId, outcome }));
        return;
      }
      server.handleMessage(value);
    },
    onMainDataFrame: (value) => mainServer.handleMessage(value),
    onClosed: () => { controlClient.handlePortClosed(); server.handlePortClosed(); mainServer.handlePortClosed(); }
  });
  if (process.env.SAND_DISABLE_LOCAL_EXEC_DAEMON !== "1") {
    void localExecSupervisor.start();
  } else {
    process.stderr.write("node-agent-coordinator: local-exec daemon supervisor disabled (headless runtime)\n");
  }
  gatewayClient.start();
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void composeCoordinator().catch((error) => {
    process.stderr.write(`node-agent-coordinator: composition failure: ${String(error)}\n`);
    process.exit(1);
  });
}
