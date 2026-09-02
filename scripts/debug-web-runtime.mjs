#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repoRoot, ".build", "web-runtime");
const repoDataDir = process.env.FAST_DEBUG_DATA_DIR ?? path.join(repoRoot, ".build", "fast-debug", "data");

const envFile = path.join(repoRoot, "deploy", ".env");
const fileEnv = existsSync(envFile)
  ? Object.fromEntries((await readFile(envFile, "utf8")).split("\n").filter((line) => line.includes("=") && !line.trim().startsWith("#")).map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]))
  : {};

const env = {
  ...process.env,
  GROK_BOT_LISTEN_HOST: "127.0.0.1",
  GROK_BOT_LISTEN_PORT: process.env.FAST_DEBUG_PORT ?? "8124",
  GROK_BOT_DATA_DIR: repoDataDir,
  RUNTIME_DEBUG: "1",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? fileEnv.OPENROUTER_API_KEY ?? "",
  SAND_HOST_GATEWAY_URL: process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340",
  SAND_HOST_GATEWAY_TOKEN: process.env.SAND_HOST_GATEWAY_TOKEN ?? fileEnv.SAND_GATEWAY_TOKEN ?? "",
};
if (env.OPENROUTER_API_KEY.length === 0) {
  process.stderr.write("[fast-debug] no OPENROUTER_API_KEY (deploy/.env)\n");
  process.exit(1);
}

const nodeBundle = {
  absWorkingDir: repoRoot,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  legalComments: "none",
  logLevel: "info",
  mainFields: ["module", "main"],
  banner: { js: "const __cleanImportMetaUrl = require(\"node:url\").pathToFileURL(__filename + \".bundled\").href;\n" },
  define: { "import.meta.url": "__cleanImportMetaUrl" },
  external: ["electron"],
};

await mkdir(path.join(out, "static"), { recursive: true });
await mkdir(path.join(out, "node-agent-coordinator"), { recursive: true });
await mkdir(repoDataDir, { recursive: true });

async function syncShim() {
  await copyFile(path.join(repoRoot, "source/server-main/web-shim.js"), path.join(out, "web-shim.js"));
  await copyFile(path.join(repoRoot, "source/server-main/web-shim.js"), path.join(out, "static/web-shim.js"));
}
await syncShim();

let child = null;
let respawning = false;
function startServer() {
  if (child != null) child.kill("SIGTERM");
  respawning = false;
  child = spawn(process.execPath, ["server-main.cjs"], { cwd: out, env, stdio: "inherit" });
  child.on("exit", (code) => {
    if (!respawning) process.stderr.write(`[fast-debug] control exited code=${code}\n`);
  });
  process.stdout.write(`[fast-debug] control on http://127.0.0.1:${env.GROK_BOT_LISTEN_PORT} — data ${repoDataDir}\n`);
}
process.on("SIGINT", () => {
  respawning = true;
  if (child != null) child.kill("SIGTERM");
  process.exit(0);
});

let rebuilds = 0;
const contexts = [];
const watchServer = await esbuild.context({
  ...nodeBundle,
  entryPoints: [path.join(repoRoot, "source/server-main/main.ts")],
  outfile: path.join(out, "server-main.cjs"),
  plugins: [{
    name: "respawn-on-rebuild",
    setup(buildApi) {
      buildApi.onEnd(() => {
        rebuilds += 1;
        if (rebuilds === 1) startServer();
        else {
          respawning = true;
          if (child != null) child.kill("SIGTERM");
          setTimeout(startServer, 250);
        }
      });
    },
  }],
});
await watchServer.watch();
contexts.push(watchServer);

const watchCoordinator = await esbuild.context({
  ...nodeBundle,
  stdin: {
    contents: `import { composeCoordinator } from "./source/node-agent-coordinator/main.ts";\nvoid composeCoordinator().catch((error) => {\n  process.stderr.write(\`node-agent-coordinator: composition failure: \${String(error)}\\n\`);\n  process.exit(1);\n});\n`,
    loader: "ts",
    resolveDir: repoRoot,
    sourcefile: path.join(repoRoot, "scripts/build-entry/node-agent-coordinator.ts"),
  },
  outfile: path.join(out, "node-agent-coordinator/main.cjs"),
});
  await watchCoordinator.watch();
contexts.push(watchCoordinator);

import { watch } from "node:fs";
watch(path.join(repoRoot, "source/server-main"), async (event, filename) => {
  if (filename != null && (filename === "web-shim.js" || filename === "overlay.js")) await syncShim();
});
process.stdout.write("[fast-debug] watching server-main, node-agent-coordinator, web-shim — edits reload in ~2s\n");
