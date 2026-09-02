import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-coord-debug-"));
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
    banner: { js: "const __cleanImportMetaUrl = require(\"node:url\").pathToFileURL(__filename + \".bundled\").href;\n" },
  });
  return { module: require(output), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const { module: configMod } = await loadModule("source/server-main/config.ts");
const { module: debugMod } = await loadModule("source/server-main/debug-log.ts");
const { module: execMod } = await loadModule("source/server-main/executors.ts");
const { module: controlMod } = await loadModule("source/electron-main/coordinator/coordinator-control-server.ts");
const { COORDINATOR_CONTROL_CHANNEL, COORDINATOR_MAIN_DATA_CHANNEL } = await import("../source/shared/rpc/coordinator-port.js");

const config = configMod.resolveRuntimeConfig({
  SAND_HOST_GATEWAY_URL: process.env.SAND_HOST_GATEWAY_URL ?? "http://box:1340",
  SAND_GATEWAY_TOKEN: process.env.SAND_GATEWAY_TOKEN ?? "",
  GROK_BOT_COORDINATOR_ARTIFACT: process.env.GROK_BOT_COORDINATOR_ARTIFACT ?? path.join(repoRoot, ".build/web-runtime/node-agent-coordinator/main.cjs"),
});
const debug = debugMod.createDebugState();
const bootstrap = JSON.stringify({
  processConfig: { appVersion: "debug", isPackaged: true, dataDir: "/tmp/grok-coord-debug" },
});

const child = fork(config.coordinatorArtifact, [`--bootstrap=${bootstrap}`], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    SAND_HOST_GATEWAY_URL: config.gatewayUrl,
    SAND_HOST_GATEWAY_TOKEN: config.gatewayToken,
    SAND_DATA_ROOT: "/tmp/grok-coord-debug",
  },
});

child.stdout?.on("data", (chunk) => process.stdout.write(`[stdout] ${chunk}`));
child.stderr?.on("data", (chunk) => process.stderr.write(`[stderr] ${chunk}`));
child.on("exit", (code, signal) => {
  console.log(`[parent] child exit code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

const executors = execMod.createHeadlessExecutors(config, debug);
const server = controlMod.createCoordinatorControlServer({
  post: (frame) => {
    if (frame.kind === "lifecycle") console.log("[parent] post lifecycle", frame.phase, frame.reason ?? "");
    child.send({ channel: COORDINATOR_CONTROL_CHANNEL, frame });
  },
  executors,
  onEvent: {
    "transport-connected": () => console.log("[parent] transport-connected"),
    "transport-down": (payload) => console.log("[parent] transport-down", JSON.stringify(payload)),
    "agents-event": (payload) => console.log("[parent] agents-event", JSON.stringify(payload).slice(0, 120)),
    "agents-roster-seed": (payload) => console.log("[parent] agents-roster-seed", JSON.stringify(payload).slice(0, 120)),
  },
  onProblem: (detail) => console.log("[parent] PROBLEM", detail),
});

child.on("message", (value) => {
  if (value == null || typeof value !== "object") return;
  if (value.channel === COORDINATOR_CONTROL_CHANNEL) {
    server.handleMessage(value.frame);
    return;
  }
  if (value.channel === COORDINATOR_MAIN_DATA_CHANNEL) {
    console.log("[parent] main-data", JSON.stringify(value.frame).slice(0, 120));
    return;
  }
  console.log("[parent] data", JSON.stringify(value).slice(0, 160));
});

setTimeout(() => console.log("[parent] still running at 15s"), 15_000);
