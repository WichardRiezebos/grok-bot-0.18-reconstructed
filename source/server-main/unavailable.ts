export const DOCKER_UNAVAILABLE = "docker/unavailable";

export class DockerUnavailableError extends Error {
  readonly code = DOCKER_UNAVAILABLE;
  constructor(method: string, detail = "Unavailable in the Docker web runtime.") {
    super(`${method}: ${detail}`);
    this.name = "DockerUnavailableError";
  }
}

export function unavailable(method: string, detail?: string): never {
  throw new DockerUnavailableError(method, detail);
}
