import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOCKER_ENGINE_UNAVAILABLE,
  dockerHostFromSocket,
  dockerSpawnEnvironment,
  existingDockerSockets,
  formatDockerUnavailable,
  isDockerCliMissingOutput,
  isDockerDaemonUnreachableOutput,
  isDockerUnavailableOutput,
  resolveDockerCliPath,
} from "../../shared/node/docker-cli.js";
import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
export const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";
export const LOCAL_DOCKER_GATEWAY_URL = "http://127.0.0.1:1340";
export const LOCAL_DOCKER_OWNER_LABEL = "com.grok-bot.local-vm=1";
export const LOCAL_DOCKER_SCHEMA_VERSION = "7";
export const LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "RESTART_CHROME=0",
  'REAL="/opt/google/chrome/google-chrome.real"',
  'CURRENT="/opt/google/chrome/google-chrome"',
  'if [ -e "$CURRENT" ] && [ ! -e "$REAL" ]; then',
  '  mv "$CURRENT" "$REAL"',
  "  cat > \"$CURRENT\" << 'EOF'",
  "#!/usr/bin/env bash",
  'exec /opt/google/chrome/google-chrome.real --disable-gpu --disable-software-rasterizer "$@"',
  "EOF",
  '  chmod 0755 "$CURRENT"',
  "  RESTART_CHROME=1",
  "fi",
  'ORIG="/usr/local/bin/start-window.sand-orig"',
  "if [ -x /usr/local/bin/start-window ] && [ ! -e \"$ORIG\" ]; then",
  "  cp /usr/local/bin/start-window \"$ORIG\"",
  "  cat > /usr/local/bin/start-window << 'EOF'",
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  '/usr/local/bin/start-window.sand-orig "$@"',
  "status=$?",
  'DISPLAY_NUM="${1:-}"',
  'if [ "$status" -ne 0 ] || ! [ "${DISPLAY_NUM}" -ge 2 ] 2>/dev/null; then',
  '  exit "$status"',
  "fi",
  "VNC_PORT=$((5900 + DISPLAY_NUM))",
  "for _ in $(seq 1 150); do",
  '  if (echo >/dev/tcp/127.0.0.1/${VNC_PORT}) >/dev/null 2>&1; then',
  "    exit 0",
  "  fi",
  "  sleep 0.2",
  "done",
  'echo "start-window: VNC :${VNC_PORT} did not become ready" >&2',
  'exit "$status"',
  "EOF",
  "  chmod 0755 /usr/local/bin/start-window",
  "fi",
  'PROFILE_ROOT="/home/box/sand-data/chrome-profiles"',
  'mkdir -p "$PROFILE_ROOT"',
  "for n in $(seq 2 12); do",
  '  LIVE="/home/box/chrome-profile-$n"',
  '  STORE="$PROFILE_ROOT/$n"',
  '  mkdir -p "$STORE"',
  '  if [ -L "$LIVE" ]; then',
  '    current=$(readlink -f "$LIVE" 2>/dev/null || true)',
  '    wanted=$(readlink -f "$STORE" 2>/dev/null || true)',
  '    if [ "$current" != "$wanted" ]; then',
  '      pkill -f "chrome-profile-$n" >/dev/null 2>&1 || true',
  '      rm -f "$LIVE"',
  '      ln -sfn "$STORE" "$LIVE"',
  "      RESTART_CHROME=1",
  "    fi",
  '  elif [ -d "$LIVE" ]; then',
  '    pkill -f "chrome-profile-$n" >/dev/null 2>&1 || true',
  '    if [ -z "$(ls -A "$STORE" 2>/dev/null)" ]; then',
  '      rm -rf "$STORE"',
  '      mv "$LIVE" "$STORE"',
  "    else",
  '      rm -rf "$LIVE"',
  "    fi",
  '    ln -sfn "$STORE" "$LIVE"',
  "    RESTART_CHROME=1",
  '  elif [ -e "$LIVE" ]; then',
  '    pkill -f "chrome-profile-$n" >/dev/null 2>&1 || true',
  '    rm -rf "$LIVE"',
  '    ln -sfn "$STORE" "$LIVE"',
  "    RESTART_CHROME=1",
  "  else",
  '    ln -sfn "$STORE" "$LIVE"',
  "  fi",
  '  chown -h box:box "$LIVE" 2>/dev/null || true',
  '  chown -R box:box "$STORE" 2>/dev/null || true',
  "done",
  "if [ ! -x /usr/local/bin/sand-chrome-keep ]; then",
  "  cat > /usr/local/bin/sand-chrome-keep << 'EOF'",
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  "exec 9>/tmp/sand-chrome-keep.lock",
  "flock -n 9 || exit 0",
  "while true; do",
  "  for n in $(seq 2 12); do",
  "    if xdpyinfo -display \":$n\" >/dev/null 2>&1; then",
  "      port=$((9222 + n))",
  "      if ! curl -fsS --max-time 0.3 \"http://127.0.0.1:${port}/json/version\" >/dev/null 2>&1; then",
  "        DISPLAY=\":$n\" HOME=/home/box /usr/local/bin/box-chrome >/dev/null 2>&1 || true",
  "      fi",
  "    fi",
  "  done",
  "  sleep 4",
  "done",
  "EOF",
  "  chmod 0755 /usr/local/bin/sand-chrome-keep",
  "fi",
  "setsid /usr/local/bin/sand-chrome-keep >/dev/null 2>&1 < /dev/null &",
  'if [ "${RESTART_CHROME:-0}" = "1" ]; then',
  '  pkill -f "/opt/google/chrome/google-chrome" >/dev/null 2>&1 || true',
  "fi",
  "exit 0",
  "",
].join("\n");
export const LOCAL_DOCKER_BOX_SECRETS_FILENAME = "box-secrets.json";
export const LOCAL_DOCKER_BOX_SECRETS_CONTAINER_PATHS = [
  "/home/box/sand-data/box-secrets.json",
  "/home/box/.cursor/sand-dev/box-secrets.json",
] as const;
const READY_TIMEOUT_MS = 180_000;
const OPTIONAL_CREDENTIAL_TIMEOUT_MS = 3_000;

export interface LocalDockerSecretsSource {
  readonly exportBoxSecrets?: () => Promise<Readonly<Record<string, string>>>;
}

export interface LocalDockerStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly containerName: string;
  readonly image: string;
  readonly detail: string;
  readonly imageUpdateAvailable?: boolean;
}

interface CommandResult { readonly ok: boolean; readonly output: string }
interface InferenceCredential { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number }
interface LocalHostBundle { readonly path: string; readonly sha256: string; readonly boxExecDaemonPath: string; readonly boxExecDaemonSha256: string }

let cachedDockerCli: string | null | undefined;
let cachedDockerHost: string | undefined;

function dockerCliPath(): string | null {
  if (cachedDockerCli === undefined) cachedDockerCli = resolveDockerCliPath();
  return cachedDockerCli;
}

function spawnDocker(cliPath: string, args: readonly string[], dockerHost?: string): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const env = dockerHost == null ? dockerSpawnEnvironment(cliPath) : dockerSpawnEnvironment(cliPath, { dockerHost });
    const child = spawn(cliPath, [...args], { stdio: ["ignore", "pipe", "pipe"], env });
    let output = "";
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => resolvePromise({ ok: false, output: `${output}\n${error.message}`.trim() }));
    child.once("close", (code) => resolvePromise({ ok: code === 0, output: output.trim() }));
  });
}

async function runDocker(args: readonly string[], dockerHost?: string): Promise<CommandResult> {
  const cliPath = dockerCliPath();
  if (cliPath == null) return { ok: false, output: DOCKER_ENGINE_UNAVAILABLE };
  const host = dockerHost ?? cachedDockerHost;
  return host == null ? await spawnDocker(cliPath, args) : await spawnDocker(cliPath, args, host);
}

async function dockerInfo(): Promise<CommandResult> {
  const first = await runDocker(["info", "--format", "{{.ServerVersion}}"]);
  if (first.ok) return first;
  const formatted = { ok: false as const, output: formatDockerUnavailable(first.output) };
  if ((process.env.DOCKER_HOST?.trim().length ?? 0) > 0) return formatted;
  if (isDockerCliMissingOutput(first.output) || first.output === DOCKER_ENGINE_UNAVAILABLE) return formatted;
  if (!isDockerDaemonUnreachableOutput(first.output)) return first;
  for (const socket of existingDockerSockets()) {
    const dockerHost = dockerHostFromSocket(socket);
    const retried = await runDocker(["info", "--format", "{{.ServerVersion}}"], dockerHost);
    if (retried.ok) {
      cachedDockerHost = dockerHost;
      return retried;
    }
  }
  return formatted;
}

function credentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-vm.json");
}

function inferenceCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-credential", "inference.json");
}

export function localDockerBoxSecretsPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-credential", LOCAL_DOCKER_BOX_SECRETS_FILENAME);
}

export function hostBoxSecretsPath(settingsPath: string): string {
  return join(dirname(settingsPath), LOCAL_DOCKER_BOX_SECRETS_FILENAME);
}

async function writeSecretsFile(target: string, secrets: Readonly<Record<string, string>>): Promise<string> {
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return target;
}

export async function writeLocalDockerBoxSecrets(settingsPath: string, secrets: Readonly<Record<string, string>>): Promise<string> {
  await writeSecretsFile(hostBoxSecretsPath(settingsPath), secrets);
  return await writeSecretsFile(localDockerBoxSecretsPath(settingsPath), secrets);
}

export async function installLocalDockerBoxSecrets(settingsPath: string): Promise<boolean> {
  const target = localDockerBoxSecretsPath(settingsPath);
  try { await access(target); } catch { return true; }
  const inspected = await inspectContainer();
  if (!inspected.exists || !inspected.running) return true;
  const prepared = await runDocker(["exec", LOCAL_DOCKER_BOX_CONTAINER, "mkdir", "-p", "/home/box/sand-data", "/home/box/.cursor/sand-dev"]);
  if (!prepared.ok) return false;
  for (const destination of LOCAL_DOCKER_BOX_SECRETS_CONTAINER_PATHS) {
    const copied = await runDocker(["cp", target, `${LOCAL_DOCKER_BOX_CONTAINER}:${destination}`]);
    if (!copied.ok) return false;
  }
  return true;
}

export async function installLocalDockerChromeConverge(): Promise<boolean> {
  const inspected = await inspectContainer();
  if (!inspected.exists || !inspected.running) return true;
  const script = LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT;
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const installed = await runDocker([
    "exec", "-u", "root", LOCAL_DOCKER_BOX_CONTAINER,
    "bash", "-lc", `printf '%s' '${encoded}' | base64 -d > /tmp/sand-chrome-converge.sh && chmod 0755 /tmp/sand-chrome-converge.sh && timeout 60 bash /tmp/sand-chrome-converge.sh`,
  ]);
  return installed.ok;
}

async function persistInferenceCredential(settingsPath: string, credential: InferenceCredential): Promise<string> {
  const target = inferenceCredentialPath(settingsPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ accessToken: credential.accessToken, expiresAtMs: credential.expiresAtMs })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return target;
}

async function readOrCreateToken(settingsPath: string): Promise<string> {
  const target = credentialPath(settingsPath);
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length >= 32) return parsed.token;
  } catch {}
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ schemaVersion: 1, token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  return token;
}

async function gatewayReady(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${LOCAL_DOCKER_GATEWAY_URL}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch { return false; }
}

async function inspectContainer(): Promise<{ exists: boolean; running: boolean; owned: boolean; image: string; hostSha256: string; hasInferenceCredential: boolean; schemaVersion: string }> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!result.ok) return { exists: false, running: false, owned: false, image: "", hostSha256: "", hasInferenceCredential: false, schemaVersion: "" };
  try {
    const value = JSON.parse(result.output) as { State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown> } };
    return {
      exists: true,
      running: value.State?.Running === true,
      owned: value.Config?.Labels?.["com.grok-bot.local-vm"] === "1",
      image: typeof value.Config?.Image === "string" ? value.Config.Image : "",
      hostSha256: typeof value.Config?.Labels?.["com.grok-bot.local-vm.host-sha256"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.host-sha256"] as string : "",
      hasInferenceCredential: value.Config?.Labels?.["com.grok-bot.local-vm.inference-credential"] === "1",
      schemaVersion: typeof value.Config?.Labels?.["com.grok-bot.local-vm.schema-version"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.schema-version"] as string : "",
    };
  } catch { throw new Error("Docker returned malformed container inspection data."); }
}

async function inspectImageId(image: string): Promise<string> {
  const result = await runDocker(["inspect", "--format", "{{.Id}}", image]);
  return result.ok ? result.output.trim() : "";
}

async function inspectContainerImageId(): Promise<string> {
  const result = await runDocker(["inspect", "--format", "{{.Image}}", LOCAL_DOCKER_BOX_CONTAINER]);
  return result.ok ? result.output.trim() : "";
}

export async function pullLocalDockerBoxImage(): Promise<void> {
  const pulled = await runDocker(["pull", LOCAL_DOCKER_BOX_IMAGE]);
  if (!pulled.ok) throw new Error(`Could not pull the local VM image: ${pulled.output}`);
}

export async function probeLocalDockerImageUpdate(): Promise<boolean> {
  const imageId = await inspectImageId(LOCAL_DOCKER_BOX_IMAGE);
  const containerImageId = await inspectContainerImageId();
  if (imageId.length === 0 || containerImageId.length === 0) return true;
  return imageId !== containerImageId;
}

export async function updateLocalDockerBox(settingsPath: string, exportBoxSecrets?: () => Promise<Readonly<Record<string, string>>>): Promise<GatewayConnection> {
  await pullLocalDockerBoxImage();
  const inspected = await inspectContainer();
  if (inspected.exists) {
    if (!inspected.owned) throw new Error(`Refusing to replace unowned container ${LOCAL_DOCKER_BOX_CONTAINER}.`);
    const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!removed.ok && !/no such container/i.test(removed.output)) throw new Error(`Could not replace the local Docker VM: ${removed.output}`);
  }
  return await ensureLocalDockerBox(settingsPath, undefined, exportBoxSecrets);
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> {
  const daemon = await dockerInfo().catch(() => ({ ok: false, output: DOCKER_ENGINE_UNAVAILABLE }));
  if (!daemon.ok) return { available: false, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: formatDockerUnavailable(daemon.output) };
  const inspected = await inspectContainer();
  if (!inspected.exists) return { available: true, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: "Ready to create the local VM.", imageUpdateAvailable: true };
  if (!inspected.owned) return { available: true, running: inspected.running, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: `Container ${LOCAL_DOCKER_BOX_CONTAINER} exists but is not owned by Grok Bot.` };
  const ready = inspected.running && await gatewayReady(await readOrCreateToken(settingsPath));
  const imageUpdateAvailable = await probeLocalDockerImageUpdate().catch(() => false);
  return { available: true, running: inspected.running, ready, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: ready ? "Local Docker VM is ready." : inspected.running ? "Container is starting." : "Local Docker VM is stopped.", imageUpdateAvailable };
}

let ensureInFlight: Promise<GatewayConnection> | undefined;

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const readRuntime = async (relative: string): Promise<Buffer> => {
    const candidates = [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)];
    for (const candidate of candidates) {
      try { return await readFile(candidate); } catch {}
    }
    throw new Error(`The reconstructed runtime is unavailable at ${candidates.join(" or ")}; refusing to start a stock local VM.`);
  };
  const hostBytes = await readRuntime("host/host-main.cjs");
  const boxExecDaemonBytes = await readRuntime("box-exec-daemon/main.cjs");
  const sha256 = createHash("sha256").update(hostBytes).digest("hex");
  const boxExecDaemonSha256 = createHash("sha256").update(boxExecDaemonBytes).digest("hex");
  const directory = join(dirname(settingsPath), "local-docker-runtime", `${sha256}-${boxExecDaemonSha256}`);
  const persistRuntime = async (name: string, bytes: Buffer): Promise<string> => {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`Content-addressed local runtime ${target} has unexpected bytes.`);
    } catch (error) {
      if (error instanceof Error && !Reflect.has(error, "code")) throw error;
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
    }
    return target;
  };
  await mkdir(directory, { recursive: true });
  return {
    path: await persistRuntime("host-main.cjs", hostBytes),
    sha256,
    boxExecDaemonPath: await persistRuntime("box-exec-daemon/main.cjs", boxExecDaemonBytes),
    boxExecDaemonSha256,
  };
}

async function localAuthMountArguments(): Promise<string[]> {
  const mounts: string[] = [];
  for (const [source, destination] of [[join(homedir(), ".codex"), "/root/.codex"], [join(homedir(), ".claude"), "/root/.claude"]] as const) {
    if (await isDirectory(source)) mounts.push("--mount", `type=bind,src=${source},dst=${destination},readonly`);
  }
  return mounts;
}

async function persistLocalDockerBoxSecrets(settingsPath: string, exportBoxSecrets?: () => Promise<Readonly<Record<string, string>>>): Promise<void> {
  if (exportBoxSecrets != null) {
    try {
      const secrets = { ...await exportBoxSecrets() };
      if (Object.keys(secrets).length > 0) await writeLocalDockerBoxSecrets(settingsPath, secrets);
    } catch {}
  }
  await installLocalDockerBoxSecrets(settingsPath);
}

async function ensureLocalDockerBox(settingsPath: string, inferenceCredential?: InferenceCredential, exportBoxSecrets?: () => Promise<Readonly<Record<string, string>>>): Promise<GatewayConnection> {
  const token = await readOrCreateToken(settingsPath);
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  const daemon = await dockerInfo().catch(() => ({ ok: false, output: DOCKER_ENGINE_UNAVAILABLE }));
  if (!daemon.ok) throw new Error(formatDockerUnavailable(daemon.output));
  const inspected = await inspectContainer();
  if (inspected.exists && !inspected.owned) throw new Error(`Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`);
  if (inspected.exists && inspected.image !== LOCAL_DOCKER_BOX_IMAGE) throw new Error(`Local Docker VM container uses unexpected image ${inspected.image}. Remove it explicitly before changing images.`);
  if (inspected.exists && (inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || (inferenceCredential != null && !inspected.hasInferenceCredential))) {
    const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!removed.ok) throw new Error(`Could not replace the local VM with the current app runtime: ${removed.output}`);
  }
  const shouldReplace = inspected.exists && (inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || (inferenceCredential != null && !inspected.hasInferenceCredential));
  const current = shouldReplace ? await inspectContainer() : inspected;
  if (current.exists && !current.running) {
    const started = await runDocker(["start", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!started.ok) throw new Error(`Could not start the local Docker VM: ${started.output}`);
  } else if (!current.exists) {
    const authMounts = await localAuthMountArguments();
    const created = await runDocker([
      "run", "--detach", "--name", LOCAL_DOCKER_BOX_CONTAINER,
      "--label", LOCAL_DOCKER_OWNER_LABEL, "--label", `com.grok-bot.local-vm.host-sha256=${hostBundle.sha256}`,
      "--label", `com.grok-bot.local-vm.box-exec-daemon-sha256=${hostBundle.boxExecDaemonSha256}`,
      "--label", `com.grok-bot.local-vm.inference-credential=${inferenceCredential == null ? "0" : "1"}`,
      "--label", `com.grok-bot.local-vm.schema-version=${LOCAL_DOCKER_SCHEMA_VERSION}`,
      "--platform", "linux/amd64", "--restart", "unless-stopped",
      "--env", "SAND_SUPERVISOR_ENABLED=1", "--env", "SAND_BOX_AUTO_UPDATE=0", "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1", "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps", "--env", "NODE_PATH=/home/box/deps", "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "--env", "SAND_HOST_PORT=1340", "--env", "SAND_DATA_ROOT=/home/box/sand-data", "--env", `SAND_GATEWAY_TOKEN=${token}`,
      ...(inferenceCredential == null ? [] : ["--env", "SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json", "--env", `SAND_BACKEND_URL=${inferenceCredential.backendUrl}`]),
      "--publish", "127.0.0.1:1337:1337", "--publish", "127.0.0.1:1339:1339", "--publish", "127.0.0.1:1340:1340",
      "--publish", "127.0.0.1:6080:6080", "--publish", "127.0.0.1:6081:6081", "--publish", "127.0.0.1:8790:8790",
      "--volume", "grok-bot-local-vm-workspace:/workspace", "--volume", "grok-bot-local-vm-data:/home/box/sand-data",
      "--mount", `type=bind,src=${hostBundle.path},dst=/home/box/sand-host/host-main.cjs,readonly`,
      "--mount", `type=bind,src=${dirname(hostBundle.boxExecDaemonPath)},dst=/home/box/box-exec-daemon,readonly`,
      ...(inferenceFile == null ? [] : ["--mount", `type=bind,src=${dirname(inferenceFile)},dst=/run/grok-bot,readonly`]),
      ...authMounts,
      LOCAL_DOCKER_BOX_IMAGE,
    ]);
    if (!created.ok) throw new Error(`Could not create the local Docker VM: ${created.output}`);
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(token)) {
      await persistLocalDockerBoxSecrets(settingsPath, exportBoxSecrets);
      await installLocalDockerChromeConverge();
      return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
    }
    const state = await inspectContainer();
    if (!state.running) {
      const logs = await runDocker(["logs", "--tail", "80", LOCAL_DOCKER_BOX_CONTAINER]);
      throw new Error(`Local Docker VM stopped before its gateway became ready.\n${logs.output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Local Docker VM did not expose its gateway within three minutes.");
}

export async function startLocalDockerBox(settingsPath: string): Promise<GatewayConnection> {
  return await ensureLocalDockerBox(settingsPath);
}

export async function stopLocalDockerBox(): Promise<void> {
  if (dockerCliPath() == null) return;
  const inspected = await inspectContainer();
  if (!inspected.exists || !inspected.running) return;
  if (!inspected.owned) throw new Error(`Refusing to stop unowned container ${LOCAL_DOCKER_BOX_CONTAINER}.`);
  const stopped = await runDocker(["stop", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!stopped.ok) {
    if (isDockerUnavailableOutput(stopped.output)) return;
    throw new Error(`Could not stop the local Docker VM: ${stopped.output}`);
  }
}

export function createSettingsRoutedHostConnector(
  remote: SandRemoteHostConnector,
  settings: SandSettingsStore,
  secrets?: LocalDockerSecretsSource,
): SandRemoteHostConnector {
  const localConnect = (): Promise<GatewayConnection> => {
    if (ensureInFlight == null) ensureInFlight = (async () => {
      let issued: InferenceCredential | undefined;
      if (remote.issueInferenceCredential != null) {
        try {
          issued = await Promise.race([
            remote.issueInferenceCredential(),
            new Promise<undefined>((resolve) => setTimeout(resolve, OPTIONAL_CREDENTIAL_TIMEOUT_MS)),
          ]);
        } catch {
          issued = undefined;
        }
      }
      return await ensureLocalDockerBox(settings.settingsPath, issued, secrets?.exportBoxSecrets);
    })().finally(() => { ensureInFlight = undefined; });
    return ensureInFlight;
  };
  return {
    connect: async () => await localConnect(),
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (): Promise<RecreateResult> => {
      await updateLocalDockerBox(settings.settingsPath, secrets?.exportBoxSecrets);
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
      await localConnect();
      return { status: "started-untrackable" };
    },
  };
}
