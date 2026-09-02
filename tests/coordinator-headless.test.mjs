import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const coordinatorArtifact = path.join(repoRoot, ".build/web-runtime/node-agent-coordinator/main.cjs");

async function bundle(entry, name) {
  const temporary = await mkdtemp(path.join(tmpdir(), `grok-${name}-`));
  const output = path.join(temporary, "module.cjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    define: { "import.meta.url": "__cleanImportMetaUrl" },
    banner: { js: "const __cleanImportMetaUrl = require('node:url').pathToFileURL(__filename + '.bundled').href;" },
  });
  return { path: output, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("headless coordinator fork stays alive with parent IPC and local-exec disabled", async () => {
  await import("node:fs/promises").then(({ access }) => access(coordinatorArtifact)).catch(() => {
    throw new Error("Run `node scripts/build-web-runtime.mjs` before coordinator headless tests");
  });
  const controlMod = await bundle("source/electron-main/coordinator/coordinator-control-server.ts", "control");
  const portMod = await bundle("source/shared/rpc/coordinator-port.ts", "port");
  const executorsMod = await bundle("source/server-main/executors.ts", "executors");
  const debugMod = await bundle("source/server-main/debug-log.ts", "debug");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-coord-data-"));
  await mkdir(dataDir, { recursive: true });

  const { COORDINATOR_CONTROL_CHANNEL, COORDINATOR_PROTOCOL_VERSION } = require(portMod.path);
  const { createCoordinatorControlServer } = require(controlMod.path);
  const { createHeadlessExecutors } = require(executorsMod.path);
  const { createDebugState } = require(debugMod.path);

  const debug = createDebugState();
  const executors = createHeadlessExecutors({
    gatewayUrl: process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340",
    gatewayToken: process.env.SAND_GATEWAY_TOKEN ?? "",
    dataDir,
  }, debug);

  const bootstrap = JSON.stringify({ processConfig: { appVersion: "test", isPackaged: true, dataDir } });
  const child = fork(coordinatorArtifact, [`--bootstrap=${bootstrap}`], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      SAND_DISABLE_LOCAL_EXEC_DAEMON: "1",
      SAND_HOST_GATEWAY_URL: process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340",
      SAND_GATEWAY_TOKEN: process.env.SAND_GATEWAY_TOKEN ?? "",
    },
  });

  const stderr = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const postControl = (frame) => child.send({ channel: COORDINATOR_CONTROL_CHANNEL, frame });
  const server = createCoordinatorControlServer({
    post: postControl,
    executors,
    onEvent: {
      "transport-connected": () => {},
      "transport-down": () => {},
      "agents-event": () => {},
      "agents-roster-seed": () => {},
    },
    onProblem: () => {},
  });

  child.on("message", (message) => {
    if (message?.channel !== COORDINATOR_CONTROL_CHANNEL) return;
    server.handleMessage(message.frame);
    const frame = message.frame;
    if (frame?.kind === "request") {
      const method = frame.method;
      const exec = executors[method];
      if (typeof exec === "function") {
        void Promise.resolve(exec(frame.args)).then(
          (value) => postControl({ kind: "reply", requestId: frame.requestId, outcome: { status: "ok", value: value ?? null } }),
          (error) => postControl({
            kind: "reply",
            requestId: frame.requestId,
            outcome: { status: "failed", failure: { code: "err", message: String(error instanceof Error ? error.message : error) } },
          }),
        );
      } else if (method.startsWith("report") || method === "getRpcTraceWindowTraceparent") {
        postControl({ kind: "reply", requestId: frame.requestId, outcome: { status: "ok", value: null } });
      }
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("coordinator headless timeout")), 12_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`coordinator exited early with code ${code}; stderr=${stderr.join("")}`));
      });
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 8_000);
    });
    assert.match(stderr.join(""), /local-exec daemon supervisor disabled/);
  } finally {
    child.kill("SIGTERM");
    await Promise.all([
      controlMod.dispose(),
      portMod.dispose(),
      executorsMod.dispose(),
      debugMod.dispose(),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  }
});

test("forkCoordinator sets SAND_DISABLE_LOCAL_EXEC_DAEMON for docker child", async () => {
  const loaded = await bundle("source/server-main/coordinator-parent.ts", "parent");
  const configMod = await bundle("source/server-main/config.ts", "config");
  const debugMod = await bundle("source/server-main/debug-log.ts", "debug2");
  const dataDir = await mkdtemp(path.join(tmpdir(), "grok-coord-parent-"));
  await mkdir(dataDir, { recursive: true });
  const coordArtifact = path.join(dataDir, "coord-echo.cjs");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(
    coordArtifact,
    "process.on('message', (value) => { if (value?.probe === 'env') process.send({ disabled: process.env.SAND_DISABLE_LOCAL_EXEC_DAEMON }); });\n",
  ));

  const { resolveRuntimeConfig } = require(configMod.path);
  const { createDebugState } = require(debugMod.path);
  const { forkCoordinator } = require(loaded.path);
  const config = resolveRuntimeConfig({
    GROK_BOT_DATA_DIR: dataDir,
    SAND_HOST_GATEWAY_URL: "http://box:1340",
    SAND_GATEWAY_TOKEN: "token",
  });
  config.coordinatorArtifact = coordArtifact;
  const debug = createDebugState();
  const session = forkCoordinator(config, debug);
  try {
    const disabled = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("env probe timeout")), 3_000);
      session.child.once("message", (value) => {
        clearTimeout(timer);
        resolve(value?.disabled);
      });
      session.child.send({ probe: "env" });
    });
    assert.equal(disabled, "1");
  } finally {
    session.dispose();
    await Promise.all([loaded.dispose(), configMod.dispose(), debugMod.dispose(), rm(dataDir, { recursive: true, force: true })]);
  }
});
