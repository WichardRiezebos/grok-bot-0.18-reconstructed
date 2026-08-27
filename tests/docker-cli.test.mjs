import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source/shared/node/docker-cli.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("PATH miss still finds OrbStack and Docker.app candidates", async () => {
  const docker = await loadModule();
  const home = "/Users/example";
  const env = { PATH: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter) };
  const present = new Set([
    join(home, ".orbstack", "bin", "docker"),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ]);
  const exists = (candidate) => present.has(candidate);
  assert.equal(docker.resolveDockerCliPath({ home, env, exists }), join(home, ".orbstack", "bin", "docker"));
  assert.equal(
    docker.resolveDockerCliPath({ home, env, exists: (candidate) => candidate === "/Applications/Docker.app/Contents/Resources/bin/docker" }),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  );
  assert.ok(docker.dockerCliCandidates({ home, env }).includes(join(home, ".orbstack", "bin", "docker")));
  assert.ok(docker.dockerSocketCandidates({ home }).includes(join(home, ".orbstack", "run", "docker.sock")));
});

test("DOCKER_PATH wins over PATH and well-known locations", async () => {
  const docker = await loadModule();
  const home = "/Users/example";
  const override = "/opt/custom/docker";
  const env = { DOCKER_PATH: override, PATH: join(home, ".orbstack", "bin") };
  const exists = (candidate) => candidate === override || candidate === join(home, ".orbstack", "bin", "docker");
  assert.equal(docker.resolveDockerCliPath({ home, env, exists }), override);
});

test("missing engine yields the friendly unavailable message", async () => {
  const docker = await loadModule();
  const home = "/Users/example";
  const env = { PATH: "/usr/bin" };
  assert.equal(docker.resolveDockerCliPath({ home, env, exists: () => false }), null);
  assert.equal(docker.formatDockerUnavailable("spawn docker ENOENT"), docker.DOCKER_ENGINE_UNAVAILABLE);
  assert.equal(docker.formatDockerUnavailable("Cannot connect to the Docker daemon"), docker.DOCKER_ENGINE_UNAVAILABLE);
  assert.equal(docker.formatDockerUnavailable(), docker.DOCKER_ENGINE_UNAVAILABLE);
  assert.ok(docker.isDockerUnavailableOutput("spawn /Users/example/.orbstack/bin/docker ENOENT"));
});

test("spawn environment prepends the CLI directory onto a stripped GUI PATH", async () => {
  const docker = await loadModule();
  const home = "/Users/example";
  const cliPath = join(home, ".orbstack", "bin", "docker");
  const env = { PATH: "/usr/bin:/bin", HOME: home };
  const spawned = docker.dockerSpawnEnvironment(cliPath, { home, env });
  const parts = spawned.PATH.split(delimiter);
  assert.equal(parts[0], join(home, ".orbstack", "bin"));
  assert.ok(parts.includes("/usr/bin"));
  assert.equal(spawned.DOCKER_HOST, undefined);
  const withHost = docker.dockerSpawnEnvironment(cliPath, { home, env, dockerHost: "unix:///Users/example/.orbstack/run/docker.sock" });
  assert.equal(withHost.DOCKER_HOST, "unix:///Users/example/.orbstack/run/docker.sock");
});
