import { computerUseExecutorResource } from "../packages/agent-exec/computer-use.js";
import { shellExecutorResource } from "../packages/agent-exec/shell.js";
import type { Executor, RemoteExecManager } from "../packages/agent-exec/remote.js";
import type { ResourceAccessor } from "../packages/agent-exec/resource-provider.js";
import { buildHostShellArgs } from "./box/box-shell-command.js";
import { createContext } from "../packages/context/core.js";
import { loggerKey } from "../packages/context/logger.js";
import type {
  ComputerUseArgs,
  ComputerUseResult as GeneratedComputerUseResult,
} from "../packages/proto/generated/agent/v1/computer_use_tool_pb.js";
import {
  toGeneratedComputerUseArgs,
} from "./runner/host-computer-tool-dependencies.js";
import {
  computerActionParameters,
  describeOutcome,
  reportedBatchPosition,
  toAction,
  type ComputerActionArgs,
  type ComputerUseResult,
  type ReportedComputerAction,
} from "./runner/tools/sand-computer-tool.js";
import {
  normalizeBoxHelpDomain,
  requestBoxHelpParameters,
} from "./runner/tools/box-help-tool.js";
import {
  ROUTED_BOX_CHROME_TOOL_NAME,
  ROUTED_BOX_HELP_TOOL_NAME,
  ROUTED_COMPUTER_SCREENSHOT_MIME,
  ROUTED_COMPUTER_TOOL_NAME,
  boxChromeDisplayPrefix,
  buildBoxChromeCommand,
  cookieConsentBoxHelpMessage,
  isCookieConsentBoxHelp,
  isRoutedUiTool,
  listRoutedComputerToolDefinitions,
  routedComputerMcpResult,
  type RoutedComputerImage,
} from "../shared/routed-computer-tools.js";
import {
  SAND_UI_CDP_PORT_BASE,
  SAND_UI_DRIVER_BOX_DIR,
  SAND_UI_DRIVER_BOX_PATH,
  SAND_UI_DRIVER_SOURCE,
  SAND_UI_RESULT_MARKER,
} from "./runner/tools/sand-ui-driver-source.js";

export { buildBoxChromeCommand };

export { listRoutedComputerToolDefinitions };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function omitNullish(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullish);
  const record = asRecord(value);
  if (record == null) return value;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (nested == null) continue;
    next[key] = omitNullish(nested);
  }
  return next;
}

export function routedComputerActionsFromArgs(raw: unknown): {
  readonly actions: ReturnType<typeof toAction>[];
  readonly reported?: ReportedComputerAction;
  readonly description?: string;
} {
  const parsed = computerActionParameters.parse(omitNullish(raw)) as ComputerActionArgs;
  const { then, ...primary } = parsed;
  const sequence = [primary, ...(then ?? [])];
  const actions = sequence.map(toAction);
  if (sequence.at(-1)?.action !== "screenshot") actions.push(toAction({ action: "screenshot" }));
  const reported = reportedBatchPosition(sequence);
  const description = parsed.description?.trim();
  return {
    actions,
    ...(reported == null ? {} : { reported }),
    ...(description == null || description.length === 0 ? {} : { description }),
  };
}

function fromGeneratedResult(result: GeneratedComputerUseResult): ComputerUseResult {
  if (result.result.case === "success") {
    const value = result.result.value;
    return {
      result: {
        case: "success",
        value: {
          ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot }),
          ...(value.cursorPosition === undefined ? {} : { cursorPosition: { x: value.cursorPosition.x, y: value.cursorPosition.y } }),
        },
      },
    };
  }
  if (result.result.case === "error") {
    return { result: { case: "error", value: { error: result.result.value.error } } };
  }
  return { result: { case: "" } };
}

function screenshotImage(result: ComputerUseResult): RoutedComputerImage | undefined {
  if (result.result.case !== "success") return undefined;
  const screenshot = (result.result.value as { screenshot?: string }).screenshot;
  return screenshot != null && screenshot.length > 0
    ? { data: screenshot, mimeType: ROUTED_COMPUTER_SCREENSHOT_MIME }
    : undefined;
}

export function parseSandUiDriverStdout(stdout: string): { readonly ok: boolean; readonly text: string } | undefined {
  const index = stdout.lastIndexOf(SAND_UI_RESULT_MARKER);
  if (index < 0) return undefined;
  const line = stdout.slice(index + SAND_UI_RESULT_MARKER.length).trim().split("\n")[0] ?? "";
  try {
    const parsed = JSON.parse(line) as { ok?: unknown; text?: unknown };
    return typeof parsed.text === "string" ? { ok: parsed.ok !== false, text: parsed.text } : undefined;
  } catch {
    return undefined;
  }
}

export function buildSandUiDriverCommand(
  op: string,
  args: unknown,
  windowIndex?: number | null,
  toolCallId = "",
): string {
  const display = windowIndex != null && Number.isInteger(windowIndex) && windowIndex >= 1 ? windowIndex : 0;
  const prefix = boxChromeDisplayPrefix(windowIndex);
  const request = Buffer.from(JSON.stringify({
    op,
    display,
    cdpPort: SAND_UI_CDP_PORT_BASE + display,
    args: args ?? {},
    toolCallId,
  }), "utf8").toString("base64");
  const source = Buffer.from(SAND_UI_DRIVER_SOURCE, "utf8").toString("base64");
  const install = `mkdir -p ${SAND_UI_DRIVER_BOX_DIR} && { test -s ${SAND_UI_DRIVER_BOX_PATH} || printf '%s' '${source}' | base64 -d > ${SAND_UI_DRIVER_BOX_PATH}; }`;
  return `${prefix}${install} && ${prefix}node ${SAND_UI_DRIVER_BOX_PATH} ${request}`;
}

export interface RoutedComputerExecHost {
  readonly box: {
    ensureReady(context: unknown, agentId: string): Promise<{ readonly remoteAccessor?: unknown }>;
    getAgentWindowIndex?(agentId: string): number | undefined;
  };
  startHandoff(request: {
    readonly agentId: string;
    readonly instruction: string;
    readonly telemetry?: { readonly reason?: string; readonly domain?: string; readonly idpDomain?: string };
  }): { readonly kind: "started" | "already-pending"; readonly requestId: string; readonly instruction?: string };
  emitComputerAction?(payload: Record<string, unknown>): void;
}

export async function executeRoutedComputerTool(
  host: RoutedComputerExecHost,
  request: unknown,
): Promise<Record<string, unknown>> {
  const record = asRecord(request) ?? {};
  const agentId = typeof record.agentId === "string" ? record.agentId : "";
  const name = typeof record.name === "string" && record.name.length > 0
    ? record.name
    : typeof record.toolName === "string" ? record.toolName : "";
  const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
  if (agentId.length === 0) {
    return routedComputerMcpResult({ text: "Computer tools need an agentId.", isError: true });
  }
  if (name === ROUTED_BOX_HELP_TOOL_NAME) {
    try {
      const args = requestBoxHelpParameters.parse(omitNullish(record.args ?? {}));
      if (isCookieConsentBoxHelp(args.instruction, args.reason)) {
        return routedComputerMcpResult({ text: cookieConsentBoxHelpMessage(), isError: true });
      }
      const domain = args.domain == null ? undefined : normalizeBoxHelpDomain(args.domain);
      const idpDomain = args.idp_domain == null ? undefined : normalizeBoxHelpDomain(args.idp_domain);
      const outcome = host.startHandoff({
        agentId,
        instruction: args.instruction,
        telemetry: {
          ...(args.reason == null ? {} : { reason: args.reason }),
          ...(domain == null ? {} : { domain }),
          ...(idpDomain == null ? {} : { idpDomain }),
        },
      });
      if (outcome.kind === "already-pending") {
        return routedComputerMcpResult({
          text: `The user still has the box: you handed it to them for "${outcome.instruction ?? args.instruction}" and they haven't handed it back, so this request was NOT sent.`,
        });
      }
      return routedComputerMcpResult({
        text: "Handed the box to the user. They have control now; wait for them to hand it back, then call observe_ui and continue.",
        handoff: { requestId: outcome.requestId, instruction: args.instruction },
      });
    } catch (error) {
      return routedComputerMcpResult({
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    }
  }
  if (name === ROUTED_BOX_CHROME_TOOL_NAME) {
    try {
      const args = asRecord(record.args) ?? {};
      const url = typeof args.url === "string" ? args.url : "";
      const context = createContext().with(loggerKey, { log: () => {} });
      const connection = await host.box.ensureReady(context, agentId);
      const accessor = connection.remoteAccessor as ResourceAccessor<RemoteExecManager> | undefined;
      if (accessor == null) {
        return routedComputerMcpResult({ text: "The box desktop is not ready yet.", isError: true });
      }
      // Window assignment exists after ensureReady; without the explicit
      // display the shell may run on a daemon bound to a different desktop.
      const windowIndex = host.box.getAgentWindowIndex?.(agentId);
      const command = buildBoxChromeCommand(url.length > 0 ? url : null, windowIndex);
      const result = await accessor.get(shellExecutorResource).execute(context as never, buildHostShellArgs({
        command,
        name: "box-chrome",
        workingDirectory: "/workspace",
        toolCallId: toolCallId.length > 0 ? toolCallId : `box-chrome-${agentId}`,
      }));
      if (result.result.case !== "success") {
        return routedComputerMcpResult({ text: `box-chrome failed (${result.result.case || "unknown"}).`, isError: true });
      }
      const { exitCode, stderr } = result.result.value as { exitCode?: number; stderr?: string };
      if (exitCode != null && exitCode !== 0) {
        const detail = (stderr ?? "").trim().slice(0, 300);
        return routedComputerMcpResult({
          text: `box-chrome exited with code ${exitCode}${detail.length > 0 ? `: ${detail}` : ""}. The Chrome window is not confirmed on screen.`,
          isError: true,
        });
      }
      return routedComputerMcpResult({
        text: url.length > 0
          ? `Opened Chrome on the box desktop at ${url}; the window is now visible. Confirm with observe_ui before claiming the page is on screen.`
          : "Opened Chrome on the box desktop; the window is now visible. Confirm with observe_ui before claiming a page is on screen.",
      });
    } catch (error) {
      return routedComputerMcpResult({
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    }
  }
  if (name === "launch_browser" || isRoutedUiTool(name)) {
    if (name === "launch_browser") {
      return routedComputerMcpResult({
        text: "launch_browser is disabled. Call box_chrome to open the existing box Chrome window the user can see.",
        isError: true,
      });
    }
    try {
      const context = createContext().with(loggerKey, { log: () => {} });
      const connection = await host.box.ensureReady(context, agentId);
      const accessor = connection.remoteAccessor as ResourceAccessor<RemoteExecManager> | undefined;
      if (accessor == null) {
        return routedComputerMcpResult({ text: "The box desktop is not ready yet.", isError: true });
      }
      const windowIndex = host.box.getAgentWindowIndex?.(agentId);
      const command = buildSandUiDriverCommand(name, record.args ?? {}, windowIndex, toolCallId);
      const result = await accessor.get(shellExecutorResource).execute(context as never, buildHostShellArgs({
        command,
        name: "observe-ui",
        workingDirectory: "/workspace",
        toolCallId: toolCallId.length > 0 ? toolCallId : `ui-${name}-${agentId}`,
      }));
      if (result.result.case !== "success") {
        return routedComputerMcpResult({ text: `${name} failed (${result.result.case || "unknown"}).`, isError: true });
      }
      const stdout = String((result.result.value as { stdout?: string }).stdout ?? "");
      const parsed = parseSandUiDriverStdout(stdout);
      if (parsed == null) {
        const stderr = String((result.result.value as { stderr?: string }).stderr ?? "").trim().slice(0, 300);
        return routedComputerMcpResult({
          text: `${name} produced no result${stderr.length > 0 ? `: ${stderr}` : "."}`,
          isError: true,
        });
      }
      return routedComputerMcpResult({ text: parsed.text, isError: !parsed.ok });
    } catch (error) {
      return routedComputerMcpResult({
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    }
  }
  if (name !== ROUTED_COMPUTER_TOOL_NAME) {
    return routedComputerMcpResult({ text: `Unknown Grok Bot computer tool: ${name || "(missing)"}`, isError: true });
  }
  try {
    const built = routedComputerActionsFromArgs(record.args ?? {});
    if (built.reported != null) {
      host.emitComputerAction?.({ agentId, ...built.reported });
    }
    const context = createContext().with(loggerKey, { log: () => {} });
    const connection = await host.box.ensureReady(context, agentId);
    const accessor = connection.remoteAccessor as ResourceAccessor<RemoteExecManager> | undefined;
    if (accessor == null) {
      return routedComputerMcpResult({ text: "The box desktop is not ready yet.", isError: true });
    }
    const executor = accessor.get(computerUseExecutorResource) as Executor<ComputerUseArgs, GeneratedComputerUseResult>;
    const generated = await executor.execute(context as never, toGeneratedComputerUseArgs({
      toolCallId,
      actions: built.actions,
      ...(built.description == null ? {} : { description: built.description }),
    }));
    const result = fromGeneratedResult(generated);
    const text = describeOutcome(result, "computer");
    if (result.result.case === "error") {
      return routedComputerMcpResult({ text, isError: true });
    }
    const image = screenshotImage(result);
    return routedComputerMcpResult({ text, ...(image == null ? {} : { image }) });
  } catch (error) {
    return routedComputerMcpResult({
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    });
  }
}
