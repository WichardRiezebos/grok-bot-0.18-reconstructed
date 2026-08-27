import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const DOCKER_ENGINE_UNAVAILABLE =
  "No Docker engine found. Start OrbStack, Docker Desktop, or another Docker-compatible runtime, then try again.";

export interface DockerCliResolveOptions {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
}

function firstExisting(candidates: readonly (string | undefined)[], exists: (path: string) => boolean): string | null {
  for (const candidate of candidates) if (candidate != null && candidate.length > 0 && exists(candidate)) return candidate;
  return null;
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(delimiter).filter(Boolean);
}

export function wellKnownDockerCliDirectories(home: string): string[] {
  return [
    join(home, ".orbstack", "bin"),
    join(home, ".docker", "bin"),
    "/Applications/Docker.app/Contents/Resources/bin",
    join(home, ".rd", "bin"),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

export function dockerCliCandidates(options: DockerCliResolveOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const override = env.DOCKER_PATH?.trim();
  const fromPath = pathEntries(env).map((directory) => join(directory, "docker"));
  const wellKnown = wellKnownDockerCliDirectories(home).map((directory) => join(directory, "docker"));
  const ordered = [override, ...fromPath, ...wellKnown].filter((value): value is string => value != null && value.length > 0);
  return [...new Set(ordered)];
}

export function resolveDockerCliPath(options: DockerCliResolveOptions = {}): string | null {
  return firstExisting(dockerCliCandidates(options), options.exists ?? existsSync);
}

export function dockerSocketCandidates(options: DockerCliResolveOptions = {}): string[] {
  const home = options.home ?? homedir();
  return [
    join(home, ".orbstack", "run", "docker.sock"),
    join(home, ".colima", "default", "docker.sock"),
    join(home, ".rd", "docker.sock"),
    "/var/run/docker.sock",
  ];
}

export function resolveDockerSocketPath(options: DockerCliResolveOptions = {}): string | null {
  return firstExisting(dockerSocketCandidates(options), options.exists ?? existsSync);
}

export function existingDockerSockets(options: DockerCliResolveOptions = {}): string[] {
  const exists = options.exists ?? existsSync;
  return dockerSocketCandidates(options).filter((socket) => exists(socket));
}

export function dockerHostFromSocket(socketPath: string): string {
  return `unix://${socketPath}`;
}

export function dockerSpawnEnvironment(
  cliPath: string,
  options: DockerCliResolveOptions & { readonly dockerHost?: string } = {},
): NodeJS.ProcessEnv {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const prepended = [dirname(cliPath), ...wellKnownDockerCliDirectories(home), ...pathEntries(env)];
  const next: NodeJS.ProcessEnv = { ...env, PATH: [...new Set(prepended)].join(delimiter) };
  if (options.dockerHost != null && options.dockerHost.length > 0) next.DOCKER_HOST = options.dockerHost;
  return next;
}

export function isDockerCliMissingOutput(output: string): boolean {
  return /spawn .*enoent|enoent|not found|no such file/i.test(output);
}

export function isDockerDaemonUnreachableOutput(output: string): boolean {
  return /cannot connect|daemon is not running|connection refused|error during connect|is the docker daemon running/i.test(output);
}

export function isDockerUnavailableOutput(output: string): boolean {
  return output === DOCKER_ENGINE_UNAVAILABLE
    || isDockerCliMissingOutput(output)
    || isDockerDaemonUnreachableOutput(output);
}

export function formatDockerUnavailable(output?: string): string {
  if (output == null || output.trim().length === 0 || isDockerUnavailableOutput(output)) return DOCKER_ENGINE_UNAVAILABLE;
  return output.trim();
}
