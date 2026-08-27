import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";

export class SandUpdateDownloadError extends Error {}

export interface UpdateDownloadProgress { readonly receivedBytes: number; readonly totalBytes: number | null }
export interface DownloadAndVerifyOptions {
  readonly url: string;
  readonly destinationPath: string;
  readonly sha256?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (progress: UpdateDownloadProgress) => void;
  readonly reportCleanupFailure?: (error: unknown) => void;
}

export async function downloadAndVerify(options: DownloadAndVerifyOptions): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(options.url, { redirect: "follow", ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (!response.ok) throw new SandUpdateDownloadError(`Update download failed: HTTP ${response.status} for ${options.url}`);
  if (response.body == null) throw new SandUpdateDownloadError(`Update download failed: empty response for ${options.url}`);
  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength != null && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
  const hash = options.sha256 != null ? createHash("sha256") : null;
  let receivedBytes = 0;
  try {
    const file = createWriteStream(options.destinationPath);
    try {
      const reader = response.body.getReader();
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { file.off("error", onError); reject(error); };
        file.on("error", onError);
        const pump = async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              hash?.update(value);
              receivedBytes += value.byteLength;
              options.onProgress?.({ receivedBytes, totalBytes });
              if (!file.write(value)) await new Promise<void>((drainResolve, drainReject) => {
                const onDrain = () => { file.off("error", drainReject); drainResolve(); };
                file.once("drain", onDrain);
                file.once("error", drainReject);
              });
            }
            file.end((error?: Error | null) => error == null ? resolve() : reject(error));
          } catch (error) { reject(error); }
        };
        void pump();
      });
    } catch (error) { file.destroy(); throw error; }
    if (hash != null && options.sha256 != null) {
      const digest = hash.digest("hex");
      if (digest !== options.sha256) throw new SandUpdateDownloadError(`Update download failed integrity check: expected sha256 ${options.sha256}, got ${digest}`);
    }
  } catch (error) {
    await rm(options.destinationPath, { force: true }).catch((cleanupError) => options.reportCleanupFailure?.(cleanupError));
    throw error;
  }
}
