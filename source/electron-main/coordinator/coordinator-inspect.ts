import { isRoutedInferenceLogLine } from "../../shared/routed-inference-log.js";

export const DEFAULT_COORDINATOR_INSPECT_PORT = 9229;

export function parseCoordinatorInspectPort(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (trimmed == null || trimmed.length === 0) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return undefined;
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on" || lower === "inspect") {
    return DEFAULT_COORDINATOR_INSPECT_PORT;
  }
  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return undefined;
  return port;
}

export function coordinatorInspectForkOptions(env: NodeJS.ProcessEnv = process.env): {
  readonly execArgv?: readonly string[];
  readonly stdio?: "pipe";
  readonly inspectPort?: number;
} {
  const inspectPort = parseCoordinatorInspectPort(env.GROK_BOT_INSPECT_COORDINATOR);
  if (inspectPort == null) return {};
  return {
    execArgv: [`--inspect=${inspectPort}`],
    stdio: "pipe",
    inspectPort,
  };
}

export interface CoordinatorStdioProcess {
  readonly stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  readonly stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
}

export function attachCoordinatorStdio(
  child: CoordinatorStdioProcess,
  write: (line: string) => void,
  inspectPort?: number,
): void {
  if (inspectPort != null) {
    write(`coordinator inspector listening on 127.0.0.1:${inspectPort} (chrome://inspect)`);
  }
  const pipe = (stream: CoordinatorStdioProcess["stdout"]): void => {
    stream?.on("data", chunk => {
      for (const raw of String(chunk).split("\n")) {
        const text = raw.replace(/\s+$/u, "");
        if (text.length === 0 || isRoutedInferenceLogLine(text)) continue;
        write(`coordinator-stdio ${text}`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
}
