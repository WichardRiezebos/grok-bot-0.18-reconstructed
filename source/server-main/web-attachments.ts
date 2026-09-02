import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import { attachmentByteLimitForName } from "../shared/media/attachment-limits.js";
import {
  audioMimeFromPath,
  servableImageMimeFromPath,
  videoMimeFromPath,
} from "../shared/media/image-mime.js";
import { posixPathFromFileUrl } from "../shared/node/paths.js";
import type { RuntimeConfig } from "./config.js";
import { postGatewayCommand } from "./gateway-rpc.js";

const ATTACHMENT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const PREVIEW_BYTE_CAP = 4 * 1024 * 1024;

function stagingDirFor(dataDir: string): string {
  return join(dataDir, "attachment-staging");
}

export function isSafeAttachmentFilename(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

export function isWithinStagingDir(stagingRoot: string, target: string): boolean {
  const resolved = resolve(stagingRoot, target);
  const rel = relative(stagingRoot, resolved);
  return rel !== "" && !rel.startsWith("..");
}

export function normalizeAttachmentBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return Uint8Array.from(value);
  }
  if (typeof value === "object" && value != null) {
    const record = value as { type?: unknown; data?: unknown };
    if (record.type === "Buffer" && Array.isArray(record.data)) {
      return Uint8Array.from(record.data.filter((entry): entry is number => typeof entry === "number"));
    }
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      return Uint8Array.from(Buffer.from(value, "base64"));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeAttachmentSource(source: unknown): string | null {
  if (typeof source !== "string" || source.length === 0) return null;
  if (source.startsWith("file:")) {
    try {
      return posixPathFromFileUrl(source);
    } catch {
      return null;
    }
  }
  return source;
}

function mediaUrlForPath(config: RuntimeConfig, filePath: string): string {
  const encoded = encodeURIComponent(filePath);
  return new URL(`/media?path=${encoded}`, config.publicUrl).toString();
}

export function createWebAttachmentHandlers(config: RuntimeConfig) {
  const stagingRoot = stagingDirFor(config.dataDir);

  return {
    async stageAttachmentBytes(payload: unknown): Promise<{ ok: boolean; path?: string; reason?: string }> {
      const record = payload != null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const filename = record.filename;
      const bytes = normalizeAttachmentBytes(record.bytes);
      if (!isSafeAttachmentFilename(filename) || bytes == null) {
        return { ok: false, reason: "failed" };
      }
      if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
      if (bytes.byteLength > attachmentByteLimitForName(filename)) {
        return { ok: false, reason: "too-large" };
      }
      await mkdir(stagingRoot, { recursive: true });
      const stagedPath = join(stagingRoot, `${Date.now()}-${randomUUID()}${extname(filename)}`);
      await writeFile(stagedPath, bytes);
      return { ok: true, path: stagedPath };
    },

    async commitStagedAttachments(payload: unknown): Promise<string[] | null> {
      const record = payload != null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const paths = Array.isArray(record.paths) ? record.paths : [];
      const filenames = Array.isArray(record.filenames) ? record.filenames : [];
      const committed: string[] = [];
      for (let index = 0; index < paths.length; index += 1) {
        const stagedPath = paths[index];
        const filename = filenames[index];
        if (typeof stagedPath !== "string"
          || stagedPath.length === 0
          || !isSafeAttachmentFilename(filename)
          || !isWithinStagingDir(stagingRoot, stagedPath)) {
          return null;
        }
        const bytes = await readFile(stagedPath);
        if (bytes.byteLength === 0) return null;
        const uploaded = await postGatewayCommand(config, "uploadAttachment", {
          filename,
          bytesBase64: bytes.toString("base64"),
        }) as { path?: unknown };
        if (typeof uploaded?.path !== "string" || uploaded.path.length === 0) return null;
        committed.push(uploaded.path);
        await rm(stagedPath, { force: true }).catch(() => undefined);
      }
      return committed;
    },

    async discardStagedAttachment(payload: unknown): Promise<null> {
      const record = payload != null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const stagedPath = record.path;
      if (typeof stagedPath !== "string"
        || stagedPath.length === 0
        || !isWithinStagingDir(stagingRoot, stagedPath)) {
        return null;
      }
      await rm(stagedPath, { force: true }).catch(() => undefined);
      return null;
    },

    async resolveAttachmentMedia(payload: unknown): Promise<unknown> {
      const path = normalizeAttachmentSource(
        payload != null && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).source
          : undefined,
      );
      if (path == null) return null;
      if (videoMimeFromPath(path) != null) {
        return { kind: "video", src: mediaUrlForPath(config, path), width: null, height: null };
      }
      if (audioMimeFromPath(path) != null) {
        return { kind: "audio", src: mediaUrlForPath(config, path) };
      }
      if (servableImageMimeFromPath(path) == null) return null;
      const image = await postGatewayCommand(config, "readAttachmentImage", { path }) as {
        dataUrl?: unknown;
        width?: unknown;
        height?: unknown;
      } | null;
      if (image == null || typeof image.dataUrl !== "string") return null;
      return {
        kind: "image",
        dataUrl: image.dataUrl,
        width: typeof image.width === "number" ? image.width : null,
        height: typeof image.height === "number" ? image.height : null,
      };
    },

    async readAttachmentText(payload: unknown): Promise<unknown> {
      const record = payload != null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const path = normalizeAttachmentSource(record.path);
      if (path == null) return null;
      return postGatewayCommand(config, "readAttachmentText", { path });
    },

    async readAttachmentBytes(payload: unknown): Promise<unknown> {
      const record = payload != null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const path = normalizeAttachmentSource(record.path);
      if (path == null) return null;
      const cap = typeof record.maxBytes === "number"
        && Number.isFinite(record.maxBytes)
        && record.maxBytes > 0
        ? Math.min(Math.floor(record.maxBytes), PREVIEW_BYTE_CAP)
        : PREVIEW_BYTE_CAP;
      const chunk = await postGatewayCommand(config, "readAttachmentChunk", {
        path,
        offset: 0,
        length: Math.min(cap, ATTACHMENT_CHUNK_MAX_BYTES),
      }) as { totalSize?: unknown; bytesBase64?: unknown } | null;
      if (chunk == null || typeof chunk.bytesBase64 !== "string") return null;
      const totalSize = typeof chunk.totalSize === "number" ? chunk.totalSize : null;
      if (totalSize != null && totalSize > cap) return { kind: "too-large", size: totalSize };
      const bytes = Buffer.from(chunk.bytesBase64, "base64");
      return { kind: "bytes", bytes: [...bytes] };
    },
  };
}

export function attachmentMediaRouteHandler(
  config: RuntimeConfig,
  pathName: string,
): { path: string } | null {
  if (!pathName.startsWith("/media")) return null;
  const url = new URL(pathName, "http://127.0.0.1");
  const filePath = url.searchParams.get("path");
  if (filePath == null || filePath.length === 0) return null;
  return { path: filePath };
}

export async function readAttachmentMediaBytes(
  config: RuntimeConfig,
  filePath: string,
  offset = 0,
  length = ATTACHMENT_CHUNK_MAX_BYTES,
): Promise<{ totalSize: number; bytes: Buffer } | null> {
  const chunk = await postGatewayCommand(config, "readAttachmentChunk", {
    path: filePath,
    offset,
    length,
  }) as { totalSize?: unknown; bytesBase64?: unknown } | null;
  if (chunk == null || typeof chunk.bytesBase64 !== "string") return null;
  const totalSize = typeof chunk.totalSize === "number" ? chunk.totalSize : 0;
  return { totalSize, bytes: Buffer.from(chunk.bytesBase64, "base64") };
}
