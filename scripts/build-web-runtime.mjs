import { mkdir, cp, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { applyOriginalRendererRouterPatch } from "./lib/router-renderer-patch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".build", "web-runtime");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

await mkdir(out, { recursive: true });
await mkdir(path.join(out, "static"), { recursive: true });
await mkdir(path.join(out, "renderer"), { recursive: true });
await writeFile(path.join(out, "renderer", ".keep"), "");

const nodeBundle = {
  absWorkingDir: root,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  legalComments: "none",
  logLevel: "info",
  // Prefer package ESM entrypoints when bundling to CJS. UMD entrypoints such
  // as jsonc-parser capture a factory-local `require`, which cannot retain
  // its package-relative resolution once flattened into host-main.cjs.
  mainFields: ["module", "main"],
  banner: { js: "const __cleanImportMetaUrl = require(\"node:url\").pathToFileURL(__filename + \".bundled\").href;\n" },
  define: { "import.meta.url": "__cleanImportMetaUrl" },
  external: ["electron"],
};

await build({
  ...nodeBundle,
  entryPoints: [path.join(root, "source/server-main/main.ts")],
  outfile: path.join(out, "server-main.cjs"),
});

await build({
  ...nodeBundle,
  stdin: {
    contents: `import { composeCoordinator } from "./source/node-agent-coordinator/main.ts";
void composeCoordinator().catch((error) => {
  process.stderr.write(\`node-agent-coordinator: composition failure: \${String(error)}\\n\`);
  process.exit(1);
});
`,
    loader: "ts",
    resolveDir: root,
    sourcefile: "scripts/build-entry/node-agent-coordinator.ts",
  },
  outfile: path.join(out, "node-agent-coordinator/main.cjs"),
});

await build({
  ...nodeBundle,
  stdin: {
    contents: `import { executeBoxCopyInFromEnv } from "./source/host/extensions/box-store-sync/box-copy-in.ts";
import { productionBoxGeneratedPorts } from "./source/host/box/generated-production.ts";
import {
  convertProductionCloudAgentConversationToTrace,
  createProductionStateBackstop,
  productionSecretsContext,
} from "./source/host/production-binding-providers.ts";
import { createProductionRunnerContext } from "./source/host/runner-context-production-provider.ts";
import { createDefaultProductionTranscriptMirrorProvider } from "./source/host/transcript-mirror/production-provider.ts";
import { productionLocalExecCodec } from "./source/host/extensions/local-exec/production.ts";
import { startProductionHost } from "./source/host/main.ts";
import { bindRecoveredProductionExtensions } from "./source/host/host-production-extensions.ts";

const ports = {
  executeBoxCopyInFromEnv,
  extensionHost: {
    boxGenerated: productionBoxGeneratedPorts,
    convertCloudAgentConversationToTrace: convertProductionCloudAgentConversationToTrace,
  },
  runnerContext: createProductionRunnerContext(),
  createTranscriptMirror: createDefaultProductionTranscriptMirrorProvider(),
};
const extensionBindings = {
  stateBackstop: createProductionStateBackstop(),
  localExecCodec: productionLocalExecCodec,
  secretsContext: productionSecretsContext,
};

void startProductionHost(bindRecoveredProductionExtensions(ports, extensionBindings)).catch((error) => {
  process.stderr.write("[sand-host] fatal: " + String(error) + "\\n");
  process.exitCode = 1;
});
`,
    loader: "ts",
    resolveDir: root,
    sourcefile: "scripts/build-entry/web-runtime-host.ts",
  },
  outfile: path.join(out, "host/host-main.cjs"),
});

await build({
  ...nodeBundle,
  entryPoints: [path.join(root, "source/box-exec-daemon/cli.ts")],
  outfile: path.join(out, "box-exec-daemon/main.cjs"),
});

await build({
  ...nodeBundle,
  entryPoints: [path.join(root, "source/host/agent-isolation/agent-store-worker.ts")],
  outfile: path.join(out, "host/agent-isolation/agent-store-worker.cjs"),
});
await build({
  ...nodeBundle,
  entryPoints: [path.join(root, "source/host/agent-isolation/transcript-mirror-worker.ts")],
  outfile: path.join(out, "host/agent-isolation/transcript-mirror-worker.cjs"),
});
await build({
  ...nodeBundle,
  entryPoints: [path.join(root, "source/host/extensions/box-store-sync/box-store-vacuum-worker.ts")],
  outfile: path.join(out, "host/extensions/box-store-sync/box-store-vacuum-worker.cjs"),
});
await build({
  ...nodeBundle,
  entryPoints: [path.join(root, "source/host/extensions/content-search/search-index-worker.ts")],
  outfile: path.join(out, "host/extensions/content-search/search-index-worker.cjs"),
});

await cp(path.join(root, "source/server-main/web-shim.js"), path.join(out, "static/web-shim.js"));
await cp(path.join(root, "source/server-main/overlay.js"), path.join(out, "static/overlay.js"));
await cp(path.join(root, "source/server-main/web-shim.js"), path.join(out, "web-shim.js"));
await cp(path.join(root, "source/server-main/overlay.js"), path.join(out, "overlay.js"));

const rendererCandidates = [
  path.join(root, "src/app/dist/renderer"),
  path.join(root, "deploy/control/shipped-renderer"),
  path.join(root, ".build/fidelity-clean-runtime/dist/renderer"),
  path.join(root, ".build/clean-runtime/dist/renderer"),
];
let stagedRenderer = false;
for (const candidate of rendererCandidates) {
  if (await exists(path.join(candidate, "index.html"))) {
    await mkdir(path.join(out, "dist"), { recursive: true });
    await cp(candidate, path.join(out, "dist", "renderer"), { recursive: true });
    try {
      await applyOriginalRendererRouterPatch({ stageRoot: out });
    } catch (error) {
      const message = `Renderer router patch failed: ${error instanceof Error ? error.message : String(error)}`;
      if (process.env.GROK_BOT_ALLOW_UNPATCHED_RENDERER === "1") process.stderr.write(`${message}\n`);
      else throw new Error(message);
    }
    await cp(path.join(out, "dist", "renderer"), path.join(out, "renderer"), { recursive: true });
    stagedRenderer = true;
    process.stdout.write(`Staged shipped renderer from ${candidate}\n`);
    break;
  }
}

if (!stagedRenderer) {
  const message = "Shipped renderer was not staged (no index.html). Linux/Dokploy images need deploy/control/shipped-renderer or a bootstrapped src/app/dist/renderer.";
  if (process.env.GROK_BOT_REQUIRE_RENDERER === "1") throw new Error(message);
  process.stderr.write(`${message}\n`);
}

process.stdout.write(`Web runtime artifacts: ${out}\n`);
