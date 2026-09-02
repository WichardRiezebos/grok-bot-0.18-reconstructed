import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SAND_DEFAULT_MODEL_ID } from "../../../shared/agents/agent-model.js";
import { createCursorGenerateImageService } from "../../../shared/node/cursor-backend/cursor-generate-image.js";
import { createOpenRouterGenerateImageService } from "../../../shared/node/openrouter-generate-image.js";
import { getSandRootDir, SAND_BOX_DATA_ROOT } from "../../host-paths.js";
import { BOX_SECRETS_FILENAME, getBoxSecretsStorePath } from "../secrets/secrets-service.js";

export class SandGenerateImagePersistError extends Error {}
export interface GenerateImageAuth { readonly getAccessToken: () => Promise<string>; readonly getMachineId: () => Promise<string> }
export interface GeneratedImage { readonly imageData: string; readonly mimeType: string }
export interface PersistedImage { readonly absolutePath: string }

function secretsFromFile(path: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
  const secrets = (parsed as { secrets?: unknown }).secrets;
  if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
  return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function persistedOpenRouterApiKey(): string {
  const candidates = [
    getBoxSecretsStorePath(),
    join(getSandRootDir(), "local-docker-credential", BOX_SECRETS_FILENAME),
    join(SAND_BOX_DATA_ROOT, BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot", BOX_SECRETS_FILENAME),
    join(homedir(), ".grokbot", "local-docker-credential", BOX_SECRETS_FILENAME),
    join(homedir(), ".cursor", "sand-dev", BOX_SECRETS_FILENAME),
  ];
  for (const path of candidates) {
    try {
      const secrets = secretsFromFile(path);
      const value = secrets.OPENROUTER_API_KEY?.trim();
      if (value != null && value.length > 0) return value;
    } catch {}
  }
  return process.env.OPENROUTER_API_KEY?.trim() ?? "";
}

export function createSandGenerateImageService<Context>(
  auth: GenerateImageAuth | undefined,
  options: {
  readonly persistImage: (bytes: Uint8Array, mimeType: string) => Promise<PersistedImage | null>;
  readonly onRequestId?: (id: string) => void;
}) {
  const openRouterKey = persistedOpenRouterApiKey();
  const generateImage = openRouterKey.length > 0
    ? createOpenRouterGenerateImageService({
        getApiKey: () => openRouterKey,
        ...(process.env.SAND_OPENROUTER_IMAGE_MODEL == null || process.env.SAND_OPENROUTER_IMAGE_MODEL.trim().length === 0
          ? {}
          : { modelId: process.env.SAND_OPENROUTER_IMAGE_MODEL.trim() }),
      })
    : auth == null
      ? null
      : createCursorGenerateImageService({
          getAccessToken: auth.getAccessToken,
          getMachineId: auth.getMachineId,
          modelId: process.env.SAND_AGENT_MODEL ?? SAND_DEFAULT_MODEL_ID,
          maxMode: true,
          ...(options.onRequestId === undefined ? {} : { onRequestId: options.onRequestId }),
        });
  if (generateImage == null) {
    throw new Error("GenerateImage needs OPENROUTER_API_KEY or a signed-in Cursor account.");
  }
  return async (ctx: Context, description: string, _filePath: string, referenceImages: readonly { data: string; mimeType: string }[]) => {
    const generated = await generateImage(ctx, description, referenceImages);
    const persisted = await options.persistImage(Buffer.from(generated.imageData, "base64"), generated.mimeType);
    if (persisted == null) throw new SandGenerateImagePersistError("Failed to save the generated image into the agent's media store.");
    return { filePath: persisted.absolutePath, imageData: generated.imageData };
  };
}
