import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { resolveRuntimeConfig } from "./config.js";
import { startRuntimeServer } from "./http-server.js";

export function main(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof startRuntimeServer> {
  const config = resolveRuntimeConfig(env);
  mkdirSync(config.dataDir, { recursive: true });
  const server = startRuntimeServer(config);
  void server.ready.then(() => {
    process.stdout.write(`[grok-bot] web runtime listening at ${server.url}\n`);
  }).catch((error) => {
    process.stderr.write(`grok-bot web runtime failed to listen: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (invoked == null) return false;
  try {
    if (import.meta.url === pathToFileURL(invoked).href) return true;
  } catch {}
  const normalized = invoked.replaceAll("\\", "/");
  return normalized.endsWith("/server-main.cjs") || normalized.endsWith("/server-main/main.ts") || normalized.endsWith("server-main.cjs");
}

if (isDirectRun()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`grok-bot web runtime failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
