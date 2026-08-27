import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-struct-json-"));
  const output = path.join(temporary, "struct-json.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/struct-json.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("tool-arg Struct sanitization turns undefined-like values into empty objects", async () => {
  const loaded = await loadModule();
  try {
    for (const value of [undefined, null, "undefined", "null", "", "  undefined  "]) {
      assert.deepEqual(loaded.module.sanitizeToolInputForStruct(value), {});
    }
    assert.deepEqual(loaded.module.sanitizeToolInputForStruct({ message: "hello" }), { message: "hello" });
    assert.deepEqual(loaded.module.sanitizeToolInputForStruct("{\"message\":\"hello\"}"), { message: "hello" });
    assert.deepEqual(loaded.module.sanitizeToolInputForStruct(["not", "an", "object"]), {});
  } finally {
    await loaded.dispose();
  }
});
