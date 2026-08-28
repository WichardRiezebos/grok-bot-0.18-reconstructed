import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { mkdirSync } from "node:fs";

import { createCoordinatorControlServer } from "../electron-main/coordinator/coordinator-control-server.js";
import {
  COORDINATOR_CONTROL_CHANNEL,
  COORDINATOR_MAIN_DATA_CHANNEL,
  asCoordinatorControlEnvelope,
  asCoordinatorMainDataEnvelope,
  type CoordinatorFrame,
} from "../shared/rpc/coordinator-port.js";
import { APP_VERSION, type RuntimeConfig } from "./config.js";
import type { DebugState } from "./debug-log.js";
import { noteLog } from "./debug-log.js";
import { createHeadlessExecutors } from "./executors.js";

export function noteCoordinatorExit(debug: DebugState, childPid: number | null, code: number | null): void {
  debug.coordinatorLastExit = code;
  if (debug.coordinatorPid !== childPid) return;
  debug.coordinatorAlive = false;
  debug.coordinatorPid = null;
}

export interface CoordinatorSession {
  readonly child: ChildProcess;
  postData(frame: unknown): void;
  postMainData(frame: unknown): void;
  dispose(): void;
  onData(listener: (frame: unknown) => void): () => void;
  onMainData(listener: (frame: unknown) => void): () => void;
}

export function forkCoordinator(config: RuntimeConfig, debug: DebugState): CoordinatorSession {
  mkdirSync(config.dataDir, { recursive: true });
  const bootstrap = JSON.stringify({
    processConfig: { appVersion: APP_VERSION, isPackaged: true, dataDir: config.dataDir },
  });
  const child = fork(config.coordinatorArtifact, [`--bootstrap=${bootstrap}`], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      OPENROUTER_API_KEY: config.openRouterKey ?? process.env.OPENROUTER_API_KEY,
      SAND_HOST_GATEWAY_URL: config.gatewayUrl,
      SAND_HOST_GATEWAY_TOKEN: config.gatewayToken,
      SAND_DATA_ROOT: config.dataDir,
    },
  });
  debug.coordinatorPid = child.pid ?? null;
  debug.coordinatorAlive = true;
  child.stdout?.on("data", (chunk: Buffer) => noteLog(debug, "stdout", chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => noteLog(debug, "stderr", chunk.toString("utf8")));
  child.on("error", (error) => noteLog(debug, "control", `coordinator ipc error: ${String(error)}`));

  const dataListeners = new Set<(frame: unknown) => void>();
  const mainDataListeners = new Set<(frame: unknown) => void>();

  const sendChild = (payload: Serializable, label: string) => {
    if (!child.connected) {
      noteLog(debug, "control", `${label} skipped: ipc closed`);
      return;
    }
    try {
      child.send(payload, (error) => {
        if (error != null) noteLog(debug, "control", `${label} failed: ${String(error)}`);
      });
    } catch (error) {
      noteLog(debug, "control", `${label} failed: ${String(error)}`);
    }
  };

  const postControl = (frame: CoordinatorFrame) => {
    sendChild({ channel: COORDINATOR_CONTROL_CHANNEL, frame } as Serializable, "control send");
  };

  const server = createCoordinatorControlServer({
    post: postControl,
    executors: createHeadlessExecutors(config, debug) as unknown as Record<string, (args: unknown) => unknown>,
    onEvent: {
      "transport-connected": () => noteLog(debug, "control", "transport-connected"),
      "transport-down": (payload) => noteLog(debug, "control", `transport-down ${JSON.stringify(payload)}`),
      "agents-event": () => {},
      "agents-roster-seed": () => {},
    },
    onProblem: (detail) => noteLog(debug, "stderr", `coordinator control: ${detail}`),
  });

  child.on("message", (value) => {
    const control = asCoordinatorControlEnvelope(value);
    if (control != null) {
      server.handleMessage(control.frame);
      return;
    }
    const main = asCoordinatorMainDataEnvelope(value);
    if (main != null) {
      for (const listener of mainDataListeners) listener(main.frame);
      return;
    }
    for (const listener of dataListeners) listener(value);
  });

  child.on("exit", (code) => {
    noteCoordinatorExit(debug, child.pid ?? null, code);
    server.handlePortClosed();
    noteLog(debug, "control", `coordinator exited ${code ?? "null"}`);
  });

  return {
    child,
    postData(frame) {
      sendChild(frame as Serializable, "data send");
    },
    postMainData(frame) {
      sendChild({ channel: COORDINATOR_MAIN_DATA_CHANNEL, frame } as Serializable, "main-data send");
    },
    dispose() {
      server.dispose();
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => { dataListeners.delete(listener); };
    },
    onMainData(listener) {
      mainDataListeners.add(listener);
      return () => { mainDataListeners.delete(listener); };
    },
  };
}
