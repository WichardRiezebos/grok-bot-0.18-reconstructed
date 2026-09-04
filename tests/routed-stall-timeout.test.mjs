import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(tmpdir(), "grok-stall-"));
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

function stallingStream(delayBeforeStallMs) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "step-start" };
      await new Promise((resolve) => setTimeout(resolve, delayBeforeStallMs));
      yield { type: "text-delta", textDelta: "partial" };
      await new Promise(() => {}); // never yields again
    },
  };
}

test("collectRoutedText fails fast when the provider stream stalls", async () => {
  const loaded = await loadModule("source/host/extensions/inference/provider-session.ts");
  try {
    const { collectRoutedText } = loaded.module;
    const started = Date.now();
    await assert.rejects(
      collectRoutedText(stallingStream(30), undefined, undefined, undefined, undefined, 120),
      /stalled for \d+(?:\.\d+)?s/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `stall watchdog took ${elapsed}ms`);
  } finally {
    await loaded.dispose();
  }
});

test("collectRoutedText completes when events keep flowing", async () => {
  const loaded = await loadModule("source/host/extensions/inference/provider-session.ts");
  try {
    const { collectRoutedText } = loaded.module;
    const flowing = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 5; i += 1) {
          yield { type: "text-delta", textDelta: "ok" };
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      },
    };
    const text = await collectRoutedText(flowing, undefined, undefined, undefined, undefined, 150);
    assert.equal(text, "okokokokok");
  } finally {
    await loaded.dispose();
  }
});

test("a stalled stream counts as a transient provider error and is retried", async () => {
  const loaded = await loadModule("source/shared/routed-inference-log.ts");
  try {
    assert.equal(loaded.module.isRoutedTransientProviderError(new Error("The routed provider stream stalled for 120s and was aborted.")), true);
    assert.equal(loaded.module.isRoutedTransientProviderError(new Error("The drive session stalled for 90s and was aborted.")), true);
    assert.equal(loaded.module.isRoutedTransientProviderError(new Error("not a valid model ID")), false);
  } finally {
    await loaded.dispose();
  }
});

test("routedStallTimeoutMs honors env override and halves the turn budget", async () => {
  const loaded = await loadModule("source/shared/routed-computer-tools.ts");
  try {
    const { routedStallTimeoutMs, routedTurnTimeoutMs } = loaded.module;
    assert.equal(routedStallTimeoutMs(true, 600_000), 120_000);
    assert.equal(routedStallTimeoutMs(false, 90_000), 45_000);
    assert.equal(routedStallTimeoutMs(true, undefined), 120_000);
    assert.equal(routedStallTimeoutMs(false, 90_000, { SAND_ROUTED_STALL_TIMEOUT_MS: "30000" }), 30_000);
    assert.equal(routedTurnTimeoutMs(true, { SAND_ROUTED_COMPUTER_TURN_TIMEOUT_MS: "900000" }), 900_000);
    assert.equal(routedTurnTimeoutMs(true, {}), 600_000);
  } finally {
    await loaded.dispose();
  }
});
