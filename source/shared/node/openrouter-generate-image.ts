import { SandGenerateImageError } from "./cursor-backend/cursor-generate-image.js";
import { fetchWithConnectTimeout } from "./fetch-with-connect-timeout.js";

export const DEFAULT_OPENROUTER_IMAGE_MODEL = "black-forest-labs/flux-2-pro";
const OPENROUTER_CONNECT_TIMEOUT_MS = 15_000;

type OpenRouterImageResponse = {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | readonly unknown[];
      readonly images?: readonly { readonly image_url?: { readonly url?: string } }[];
    };
  }[];
  readonly data?: readonly { readonly b64_json?: string; readonly url?: string }[];
  readonly error?: { readonly message?: string };
};

function dataUrlToBase64(dataUrl: string): { imageData: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/u.exec(dataUrl.trim());
  if (match == null) return null;
  return { mimeType: match[1]!, imageData: match[2]! };
}

async function fetchImageAsBase64(url: string): Promise<{ imageData: string; mimeType: string }> {
  const response = await fetchWithConnectTimeout(url, undefined, OPENROUTER_CONNECT_TIMEOUT_MS);
  if (!response.ok) throw new SandGenerateImageError(`OpenRouter image download failed (${response.status}).`);
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { imageData: buffer.toString("base64"), mimeType };
}

function extractGeneratedImage(payload: OpenRouterImageResponse): { imageData: string; mimeType: string } | null {
  for (const choice of payload.choices ?? []) {
    for (const image of choice.message?.images ?? []) {
      const url = image.image_url?.url;
      if (typeof url === "string" && url.length > 0) {
        const inline = url.startsWith("data:") ? dataUrlToBase64(url) : null;
        if (inline != null) return inline;
      }
    }
    const content = choice.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== "object" || part == null) continue;
        const record = part as Record<string, unknown>;
        if (record.type === "image_url" && typeof record.image_url === "object" && record.image_url != null) {
          const url = (record.image_url as { url?: unknown }).url;
          if (typeof url === "string" && url.length > 0) {
            const inline = url.startsWith("data:") ? dataUrlToBase64(url) : null;
            if (inline != null) return inline;
          }
        }
      }
    }
  }
  for (const row of payload.data ?? []) {
    if (typeof row.b64_json === "string" && row.b64_json.length > 0) {
      return { imageData: row.b64_json, mimeType: "image/png" };
    }
    if (typeof row.url === "string" && row.url.length > 0) {
      const inline = row.url.startsWith("data:") ? dataUrlToBase64(row.url) : null;
      if (inline != null) return inline;
    }
  }
  return null;
}

export function createOpenRouterGenerateImageService(options: {
  readonly getApiKey: () => string;
  readonly modelId?: string;
}) {
  return async (
    _context: unknown,
    description: string,
    referenceImages?: readonly { data: string; mimeType: string }[],
  ) => {
    const apiKey = options.getApiKey().trim();
    if (apiKey.length === 0) {
      throw new SandGenerateImageError("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.");
    }
    const model = options.modelId?.trim() || DEFAULT_OPENROUTER_IMAGE_MODEL;
    const content: unknown[] = [{ type: "text", text: description }];
    for (const image of referenceImages ?? []) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      });
    }
    const response = await fetchWithConnectTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/grok-bot-reconstructed",
        "X-Title": "Grok Bot Reconstructed",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        modalities: ["image", "text"],
      }),
    }, OPENROUTER_CONNECT_TIMEOUT_MS);
    const payload = await response.json() as OpenRouterImageResponse;
    if (!response.ok) {
      const message = payload.error?.message?.trim() || `OpenRouter image generation failed (${response.status}).`;
      throw new SandGenerateImageError(message);
    }
    const generated = extractGeneratedImage(payload);
    if (generated == null) {
      const urlCandidate = payload.data?.find(row => typeof row.url === "string" && row.url.length > 0)?.url;
      if (typeof urlCandidate === "string" && !urlCandidate.startsWith("data:")) {
        return await fetchImageAsBase64(urlCandidate);
      }
      throw new SandGenerateImageError("OpenRouter returned no image data.");
    }
    return generated;
  };
}
