import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadConnector() {
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts")],
    format: "esm",
    platform: "node",
    write: false,
  });
  const code = result.outputFiles[0]?.text;
  assert.ok(code);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("local Docker secrets snapshot is written next to the VM credential", async () => {
  const connector = await loadConnector();
  const settingsPath = join("/Users/example/Library/Application Support/Grok Bot", "settings.json");
  assert.equal(
    connector.localDockerBoxSecretsPath(settingsPath),
    join("/Users/example/Library/Application Support/Grok Bot", "local-docker-credential", "box-secrets.json"),
  );
  const directory = await mkdtemp(join(tmpdir(), "grok-bot-box-secrets-"));
  try {
    const written = await connector.writeLocalDockerBoxSecrets(join(directory, "settings.json"), { OPENROUTER_API_KEY: "sk-or-v1-test" });
    const parsed = JSON.parse(await readFile(written, "utf8"));
    assert.equal(written, join(directory, "local-docker-credential", "box-secrets.json"));
    assert.deepEqual(parsed, { version: 1, secrets: { OPENROUTER_API_KEY: "sk-or-v1-test" } });
    const hostPath = connector.hostBoxSecretsPath(join(directory, "settings.json"));
    assert.equal(hostPath, join(directory, "box-secrets.json"));
    assert.deepEqual(JSON.parse(await readFile(hostPath, "utf8")), parsed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Docker Chrome converge wraps GPU-off Chrome and fork VNC wait", async () => {
  const connector = await loadConnector();
  assert.match(connector.LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT, /--disable-gpu --disable-software-rasterizer/);
  assert.match(connector.LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT, /start-window\.sand-orig/);
  assert.match(connector.LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT, /sand-chrome-keep/);
  assert.match(connector.LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT, /RESTART_CHROME/);
  assert.match(connector.LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT, /setsid \/usr\/local\/bin\/sand-chrome-keep.*&/);
  assert.match(connector.LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT, /sand-data\/chrome-profiles/);
  assert.match(connector.LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT, /chrome-profile-\$n/);
  assert.match(connector.LOCAL_DOCKER_CHROME_CONVERGE_SCRIPT, /ln -sfn "\$STORE" "\$LIVE"/);
  assert.equal(typeof connector.installLocalDockerChromeConverge, "function");
});
