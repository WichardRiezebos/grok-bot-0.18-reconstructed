import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-connect-timeout-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "source/shared/node/fetch-with-connect-timeout.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function withFetch(stub, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve().then(run).finally(() => {
    globalThis.fetch = previous;
  });
}

test("returns the response once headers arrive, well before slow bodies finish", async () => {
  const loaded = await loadModule();
  await withFetch(
    async () => new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => controller.enqueue(new TextEncoder().encode("late-chunk")), 120);
        setTimeout(() => controller.close(), 140);
      },
    }), { status: 200 }),
    async () => {
      const started = Date.now();
      const response = await loaded.module.fetchWithConnectTimeout("https://example.test/stream", undefined, 5_000);
      assert.equal(response.status, 200);
      assert.ok(Date.now() - started < 5_000, "wrapper resolved as soon as headers arrived");
      assert.equal(await response.text(), "late-chunk", "slow body still delivers after the timer cleared");
    },
  );
});

test("rejects with TimeoutError when headers never arrive", async () => {
  const loaded = await loadModule();
  await withFetch(
    (input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
    async () => {
      const started = Date.now();
      await assert.rejects(
        loaded.module.fetchWithConnectTimeout("https://example.test/hang", undefined, 60),
        (error) => error.name === "TimeoutError",
      );
      assert.ok(Date.now() - started < 5_000, "connect timeout fired");
    },
  );
});

test("caller abort still cancels the request after headers arrived", async () => {
  const loaded = await loadModule();
  await withFetch(
    async (input, init) => {
      assert.ok(init?.signal instanceof AbortSignal, "wrapper passes its controller signal to fetch");
      return new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
        },
      }), { status: 200 });
    },
    async () => {
      const controller = new AbortController();
      const response = await loaded.module.fetchWithConnectTimeout("https://example.test/stream", { signal: controller.signal }, 5_000);
      setTimeout(() => controller.abort(new DOMException("caller cancelled", "AbortError")), 30);
      await assert.rejects(response.text(), (error) => error.name === "AbortError");
    },
  );
});

test("rejects immediately with the caller's reason when the signal is already aborted", async () => {
  const loaded = await loadModule();
  await withFetch(
    (input, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) { reject(init.signal.reason); return; }
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
    async () => {
      const controller = new AbortController();
      controller.abort(new DOMException("pre-aborted", "AbortError"));
      await assert.rejects(
        loaded.module.fetchWithConnectTimeout("https://example.test/hang", { signal: controller.signal }, 5_000),
        (error) => error.name === "AbortError",
      );
    },
  );
});
