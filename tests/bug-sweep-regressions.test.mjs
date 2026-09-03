import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("routed MCP execute preserves name and toolName without swapping them", async () => {
  const source = await readFile(path.join(repoRoot, "source/host/host-gateway-api.ts"), "utf8");
  assert.match(source, /name:\s*args\.name,\s*\n\s*toolName:\s*args\.toolName,/);
  assert.doesNotMatch(source, /name:\s*args\.toolName/);
  assert.doesNotMatch(source, /toolName:\s*args\.name/);
});

test("coordinator dispatchRequest converts routed failures into failed outcomes", async () => {
  const source = await readFile(path.join(repoRoot, "source/node-agent-coordinator/main.ts"), "utf8");
  assert.match(source, /const routed = await inferenceRouter\.dispatch\(method, args\);/);
  assert.match(source, /return \{ status: "failed" as const, failure: failureFor\(error\) \}/);
});

test("provider deferreds attach no-op rejection handlers", async () => {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"), "utf8");
  assert.match(source, /void resolvers\.promise\.catch\(\(\) => \{\}\)/);
  assert.match(source, /void result\.response\.catch\(\(\) => \{\}\)/);
});

test("verify.mjs reconciles router-patched renderer checksums", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/verify.mjs"), "utf8");
  assert.match(source, /renderer-router-extension\.json/);
  assert.match(source, /extensionByPath\.get\(file\.path\) \?\? file/);
});

test("gateway send-post deadline applies to delete, not Computer tools", async () => {
  const source = await readFile(path.join(repoRoot, "source/node-agent-coordinator/gateway/gateway-client.ts"), "utf8");
  assert.match(source, /method === "deleteAgent" \|\| method === "deleteAgents"/);
  assert.match(source, /async command\(method: string, args: unknown, init\?: RequestInit\): Promise<unknown> \{ return \(await this\.request\(method, args, init\)\)\.result; \}/);
});

test("box-exec daemon attaches spawn error listeners instead of crashing", async () => {
  const source = await readFile(path.join(repoRoot, "source/box-exec-daemon/server.ts"), "utf8");
  assert.match(source, /async \*shellStream[\s\S]*child\.once\("error"/);
  assert.match(source, /async spawnBackground[\s\S]*child\.once\("error"/);
  assert.match(source, /process\.writeQueue = process\.writeQueue\.then\(\(\) => \{[\s\S]*appendFile\(terminalPath, data\)[\s\S]*\}\)\.catch/);
  assert.match(source, /timingSafeEqual/);
});

test("box Chrome converge disables GPU and waits for fork VNC", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  assert.match(source, /installLocalDockerChromeConverge/);
  assert.match(source, /--disable-gpu --disable-software-rasterizer/);
  assert.match(source, /RESTART_CHROME/);
  assert.match(source, /sand-chrome-keep/);
  assert.match(source, /timeout 60 bash \/tmp\/sand-chrome-converge\.sh/);
  assert.match(source, /sand-data\/chrome-profiles/);
  assert.match(source, /setsid \/usr\/local\/bin\/sand-chrome-keep.*&/);
  assert.match(source, /start-window\.sand-orig/);
  assert.match(source, /VNC_PORT=\$\(\(5900 \+ DISPLAY_NUM\)\)/);
});

test("local VM reports no image update so Update Computer is not nagged", async () => {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/forever-box/extension.ts"), "utf8");
  assert.match(source, /hostBundleAutoUpdate = isHostBundleAutoUpdateEnabled\(\)/);
  assert.match(source, /hostBundleAutoUpdate \? backendLifecycleClient : \{ recreateInBox: backendLifecycleClient\.recreateInBox\.bind\(backendLifecycleClient\), fetchImageUpdateAvailable: async \(\) => false \}/);
});

test("in-box runtime answers a missing computer registry with a live status, not a stuck Absent", async () => {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/forever-box/forever-box-service.ts"), "utf8");
  const getStatus = source.match(/async getStatus\(input: \{ id: string \}\): Promise<BoxStatus> \{.*\}/)?.[0] ?? "";
  assert.ok(getStatus.length > 0, "getStatus body not found");
  assert.match(getStatus, /state === "absent"/);
  assert.match(getStatus, /this\.options\.isInBox\(\)/);
  assert.match(getStatus, /return this\.ensure\(input\)/);
});

test("live view prefers the agent's fork VNC URL", async () => {
  const hostBox = await readFile(path.join(repoRoot, "source/host/extensions/forever-box/host-box.ts"), "utf8");
  const recovered = await readFile(path.join(repoRoot, "frontend/src/recovered/features/computer/shell/model.ts"), "utf8");
  const production = await readFile(path.join(repoRoot, "frontend/src/production/model.ts"), "utf8");
  assert.match(hostBox, /export function preferredBoxVncUrl/);
  assert.match(hostBox, /window\.windowIndex > best\.index/);
  assert.match(recovered, /function preferredStatusVncUrl/);
  assert.match(production, /index >= bestIndex/);
});

test("OpenRouter reasoning streams into the Thinking row instead of a blank gap", async () => {
  const source = await readFile(path.join(repoRoot, "source/shared/openrouter-models.ts"), "utf8");
  assert.match(source, /exclude: false/);
  assert.doesNotMatch(source, /exclude: true/);
});

test("coordinator resync pushes OpenRouter model and effort at startup", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/coordinator/coordinator-resync.ts"), "utf8");
  assert.match(source, /getInferenceRouterSettings/);
  assert.match(source, /await step\("inference_router"/);
});

test("coordinator hello on a live session re-sends ready instead of exiting", async () => {
  const source = await readFile(path.join(repoRoot, "source/node-agent-coordinator/renderer-port-server.ts"), "utf8");
  assert.doesNotMatch(source, /hello repeated on a live session/);
  assert.match(source, /phase === "serving"/);
  assert.match(source, /inFlight.clear\(\)/);
});

test("routed Computer JSON schema lists every property in required", async () => {
  const source = await readFile(path.join(repoRoot, "source/shared/routed-computer-tools.ts"), "utf8");
  assert.match(source, /function strictObject/);
  assert.match(source, /openAiStrictSchemaGap/);
});

test("web runtime keeps serving after unhandled rejections", async () => {
  const main = await readFile(path.join(repoRoot, "source/server-main/main.ts"), "utf8");
  const http = await readFile(path.join(repoRoot, "source/server-main/http-server.ts"), "utf8");
  assert.match(main, /process\.on\("unhandledRejection"/);
  assert.match(main, /process\.on\("uncaughtException"/);
  assert.match(http, /await handleRequest\(req, res\)/);
  assert.match(http, /send\(res, 500, "internal error"\)/);
});

test("OpenRouter usage is taken from the SSE stream, not a JSON clone", async () => {
  const session = await readFile(path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"), "utf8");
  assert.match(session, /observeOpenRouterSseUsage/);
  assert.match(session, /applyOpenRouterStreamUsage/);
  assert.match(session, /GROK_BOT_DATA_DIR/);
  assert.match(session, /function routedSettingsPath/);
  assert.doesNotMatch(session, /response\.clone\(\)\.json/);
});

test("coordinator fork shares the web data dir as SAND_DATA_ROOT", async () => {
  const parent = await readFile(path.join(repoRoot, "source/server-main/coordinator-parent.ts"), "utf8");
  assert.match(parent, /SAND_DATA_ROOT: config\.dataDir/);
});

test("web profile saves emit cursor-auth-changed and skip Sentry", async () => {
  const rpc = await readFile(path.join(repoRoot, "source/server-main/rpc.ts"), "utf8");
  const http = await readFile(path.join(repoRoot, "source/server-main/http-server.ts"), "utf8");
  const shim = await readFile(path.join(repoRoot, "source/server-main/web-shim.js"), "utf8");
  assert.match(rpc, /options\.emit\?\.\("cursor-auth-changed", status\)/);
  assert.match(http, /kind: "event", channel: `sand-rpc:main:e:\$\{event\}`/);
  assert.match(shim, /window\.__SENTRY__RENDERER_INIT__ = true/);
  assert.match(shim, /listener\(undefined, payload\)/);
  assert.match(shim, /sand-rpc:main:e:cursor-auth-changed/);
  assert.match(shim, /method: "stopRoutedTurn"/);
  assert.match(shim, /aria-label", "Stop"/);
  assert.match(shim, /noteRoutedSend/);
});

test("deleting the last bot does not mint a fallback Grok", async () => {
  const lifecycle = await readFile(path.join(repoRoot, "source/host/extensions/transcript/agent-lifecycle.ts"), "utf8");
  const sessions = await readFile(path.join(repoRoot, "source/host/extensions/transcript/session-runtime.ts"), "utf8");
  const agents = await readFile(path.join(repoRoot, "source/shared/agents/agents.ts"), "utf8");
  assert.match(agents, /class SandEmptyRosterError/);
  assert.match(sessions, /throw new SandEmptyRosterError/);
  assert.doesNotMatch(sessions, /createFallbackSession/);
  assert.doesNotMatch(lifecycle, /createFallbackSession/);
  assert.match(lifecycle, /deletedAgentIds\.has\(id\)/);
  assert.match(lifecycle, /agentDirExists\(id\)/);
  assert.match(lifecycle, /type: "cleared"/);
});

test("renderer drops transcript entries when a bot is deleted", async () => {
  const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  assert.match(renderer, /setEntriesByAgent\(\(current\) => \{/);
  assert.match(renderer, /\[agentId\]: _removed/);
});

test("web control plane hardening", async () => {
  const vnc = await readFile(path.join(repoRoot, "source/server-main/vnc-proxy.ts"), "utf8");
  assert.match(vnc, /\{\s*2,\s*\}\s*\/g,\s*"\/"/);
  assert.match(vnc, /target\.origin !== expectedOrigin/);
  assert.match(vnc, /VNC_PROXY_STRIPPED_HEADERS/);
  const http = await readFile(path.join(repoRoot, "source/server-main/http-server.ts"), "utf8");
  assert.match(http, /maxPayload: 1 << 20/);
  const redact = await readFile(path.join(repoRoot, "source/server-main/redact.ts"), "utf8");
  assert.match(redact, /value\.map\(\(item\) => redactValue\(item, key\)\)/);
  const rpc = await readFile(path.join(repoRoot, "source/server-main/rpc.ts"), "utf8");
  assert.match(rpc, /setHostSidebarSections: \(payload\) => \{[\s\S]*settings\.setSidebarSections/);
  assert.match(rpc, /removeSecrets: async \(payload\) => \{[\s\S]*setBoxSecrets/);
  const settings = await readFile(path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts"), "utf8");
  assert.match(settings, /randomUUID\(\)\}\.tmp/);
  assert.match(settings, /corrupt-\$\{Date\.now\(\)\}/);
});
