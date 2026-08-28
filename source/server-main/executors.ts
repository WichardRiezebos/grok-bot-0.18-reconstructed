import {
  executeComposioBackendTool,
  flattenComposioRoutedTools,
  isComposioServerIdentifier,
  listComposioBackendServers,
  readComposioApiKey,
} from "../shared/node/composio-mcp.js";
import { GATEWAY_AUTH_SCHEME } from "../shared/gateway-wire.js";
import { noteLog } from "./debug-log.js";
import { postGatewayCommand } from "./gateway-rpc.js";
import { unavailable } from "./unavailable.js";
import type { DebugState } from "./debug-log.js";
import type { RuntimeConfig } from "./config.js";

function isRoutedComposioTool(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const identifier = (value as { providerIdentifier?: unknown }).providerIdentifier;
  return isComposioServerIdentifier(typeof identifier === "string" ? identifier : undefined);
}

export function createHeadlessExecutors(config: RuntimeConfig, debug: DebugState) {
  const noteStub = (method: string, detail: string): never => {
    debug.stubs.push({ at: new Date().toISOString(), method, detail });
    return unavailable(method, detail);
  };
  return {
    resolveGatewayConnection: () => ({
      baseUrl: config.gatewayUrl,
      ...(config.gatewayToken.length > 0 ? { token: config.gatewayToken } : {}),
    }),
    listRoutedMcpTools: async () => {
      const apiKey = readComposioApiKey();
      const local = apiKey == null ? [] : flattenComposioRoutedTools(await listComposioBackendServers(apiKey));
      let remote: unknown[] = [];
      try {
        const tools = await postGatewayCommand(config, "listRoutedMcpTools", {});
        remote = Array.isArray(tools) ? tools.filter((tool) => !isRoutedComposioTool(tool)) : [];
      } catch (error) {
        noteLog(debug, "control", `listRoutedMcpTools ${error instanceof Error ? error.message : String(error)}`);
      }
      return [...local, ...remote];
    },
    executeRoutedMcpTool: async (args: unknown) => {
      const record = args != null && typeof args === "object" && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {};
      const provider = typeof record.providerIdentifier === "string" ? record.providerIdentifier : undefined;
      if (isComposioServerIdentifier(provider)) {
        return await executeComposioBackendTool(readComposioApiKey(), {
          name: typeof record.name === "string" ? record.name : undefined,
          toolName: typeof record.toolName === "string" ? record.toolName : undefined,
          args: record.args,
        });
      }
      try {
        return await postGatewayCommand(config, "executeRoutedMcpTool", args ?? {});
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Connect plugin failed (${detail}).`);
      }
    },
    mintLocalExecDaemonCredential: async () => {
      debug.stubs.push({ at: new Date().toISOString(), method: "mintLocalExecDaemonCredential", detail: "The Mac local-exec daemon is unavailable in Docker." });
      return null;
    },
    requestWebAuthnConsent: async () => noteStub("requestWebAuthnConsent", "WebAuthn is unavailable in Docker."),
    requestWebAuthnPin: async () => noteStub("requestWebAuthnPin", "WebAuthn is unavailable in Docker."),
    updateWebAuthnConsent: () => noteStub("updateWebAuthnConsent", "WebAuthn is unavailable in Docker."),
    finishWebAuthnConsent: () => noteStub("finishWebAuthnConsent", "WebAuthn is unavailable in Docker."),
    spawnLocalExecDaemon: async () => noteStub("spawnLocalExecDaemon", "The Mac local-exec daemon is unavailable in Docker."),
    terminateProcess: async () => {
      debug.stubs.push({ at: new Date().toISOString(), method: "terminateProcess", detail: "Process control is unavailable in Docker." });
      return { terminated: false };
    },
    isProcessAlive: () => false,
    getProcessIdentity: () => null,
    waitLocalExecDaemonExit: async () => noteStub("waitLocalExecDaemonExit", "No local-exec daemon in Docker."),
    getRpcTraceWindowTraceparent: () => null,
    reportTransportStage: () => {},
    reportGatewayCommandSpan: () => {},
    reportGatewayReachability: (report: unknown) => {
      noteLog(debug, "control", `gateway reachability ${JSON.stringify(report)}`);
    },
    reportGatewayDnsDiagnostic: () => {},
    reportProcessCrash: (report: unknown) => {
      noteLog(debug, "stderr", `coordinator crash ${JSON.stringify(report)}`);
    },
  };
}

export function gatewayAuthHeaders(config: RuntimeConfig): Record<string, string> {
  return config.gatewayToken.length > 0 ? { authorization: `${GATEWAY_AUTH_SCHEME} ${config.gatewayToken}` } : {};
}
