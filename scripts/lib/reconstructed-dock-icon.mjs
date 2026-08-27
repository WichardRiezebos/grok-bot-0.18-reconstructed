import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";

import { capture, run } from "./process.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

export const DEFAULT_DOCK_ICON_FILE = "electron.icns";
export const MIN_BADGE_EDGE = 32;
const ASTERISK_BLUE = Object.freeze({ r: 59, g: 130, b: 246 });
const DISC_FILL = Object.freeze({ r: 15, g: 23, b: 42 });

let pngJimpPromise;

function pngJimp() {
  pngJimpPromise ??= Promise.resolve(createJimp({ formats: [png] }));
  return pngJimpPromise;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / lengthSq, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function blendOver(data, width, height, x, y, r, g, b, coverage) {
  if (coverage <= 0 || x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  const srcA = clamp(coverage, 0, 1);
  const dstA = data[index + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    data[index] = 0;
    data[index + 1] = 0;
    data[index + 2] = 0;
    data[index + 3] = 0;
    return;
  }
  data[index] = Math.round((r * srcA + data[index] * dstA * (1 - srcA)) / outA);
  data[index + 1] = Math.round((g * srcA + data[index + 1] * dstA * (1 - srcA)) / outA);
  data[index + 2] = Math.round((b * srcA + data[index + 2] * dstA * (1 - srcA)) / outA);
  data[index + 3] = Math.round(outA * 255);
}

export function paintAsteriskBadge(bitmap) {
  const width = bitmap.width;
  const height = bitmap.height;
  const data = bitmap.data;
  if (width < MIN_BADGE_EDGE || height < MIN_BADGE_EDGE) return false;
  const size = Math.min(width, height);
  const cx = size * 0.78;
  const cy = size * 0.22;
  const discRadius = size * 0.13;
  const armLength = size * 0.11;
  const stroke = Math.max(1.15, size * 0.035);
  const pad = Math.ceil(discRadius + 2);
  const x0 = Math.max(0, Math.floor(cx - pad));
  const y0 = Math.max(0, Math.floor(cy - pad));
  const x1 = Math.min(width - 1, Math.ceil(cx + pad));
  const y1 = Math.min(height - 1, Math.ceil(cy + pad));
  const arms = [0, Math.PI / 3, (2 * Math.PI) / 3].map(angle => ({
    x1: cx + Math.cos(angle) * armLength,
    y1: cy + Math.sin(angle) * armLength,
    x2: cx - Math.cos(angle) * armLength,
    y2: cy - Math.sin(angle) * armLength,
  }));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const discCoverage = clamp(discRadius + 0.5 - Math.hypot(px - cx, py - cy), 0, 1);
      let starCoverage = 0;
      for (const arm of arms) {
        const distance = distanceToSegment(px, py, arm.x1, arm.y1, arm.x2, arm.y2);
        starCoverage = Math.max(starCoverage, clamp(stroke / 2 + 0.5 - distance, 0, 1));
      }
      if (discCoverage > 0) blendOver(data, width, height, x, y, DISC_FILL.r, DISC_FILL.g, DISC_FILL.b, discCoverage * 0.92);
      if (starCoverage > 0) blendOver(data, width, height, x, y, ASTERISK_BLUE.r, ASTERISK_BLUE.g, ASTERISK_BLUE.b, starCoverage);
    }
  }
  return true;
}

export async function badgeDockIconPng(pngBuffer) {
  if (!Buffer.isBuffer(pngBuffer) && !(pngBuffer instanceof Uint8Array)) {
    throw new TypeError("badgeDockIconPng requires a PNG buffer");
  }
  const Jimp = await pngJimp();
  const image = await Jimp.fromBuffer(pngBuffer);
  paintAsteriskBadge(image.bitmap);
  return await image.getBuffer("image/png");
}

async function readPlistString(infoPlist, key) {
  try {
    const value = await capture(SYSTEM_TOOLS.plutil, ["-extract", key, "raw", infoPlist]);
    return value.trim();
  } catch {
    return null;
  }
}

export function resolveDockIconFileName(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const base = path.basename(trimmed.length > 0 ? trimmed : DEFAULT_DOCK_ICON_FILE);
  return base.toLowerCase().endsWith(".icns") ? base : `${base}.icns`;
}

async function badgeIconset(iconsetDir) {
  const entries = await readdir(iconsetDir);
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const filePath = path.join(iconsetDir, name);
    const original = await readFile(filePath);
    const badged = await badgeDockIconPng(original);
    await writeFile(filePath, badged);
  }
}

export async function applyReconstructedDockIcon(appPath) {
  if (typeof appPath !== "string" || appPath.length === 0) {
    throw new TypeError("An explicit application bundle path is required to badge the Dock icon.");
  }
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const iconFile = resolveDockIconFileName(await readPlistString(infoPlist, "CFBundleIconFile"));
  const iconPath = path.join(appPath, "Contents", "Resources", iconFile);
  if (!(await stat(iconPath)).isFile()) {
    throw new Error(`Dock icon is missing at ${iconPath}`);
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), "reconstructed-dock-icon-"));
  try {
    const iconsetDir = path.join(workDir, "icon.iconset");
    const badgedIcns = path.join(workDir, "icon.icns");
    await run(SYSTEM_TOOLS.iconutil, ["-c", "iconset", "-o", iconsetDir, iconPath]);
    await badgeIconset(iconsetDir);
    await run(SYSTEM_TOOLS.iconutil, ["-c", "icns", "-o", badgedIcns, iconsetDir]);
    await writeFile(iconPath, await readFile(badgedIcns));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  if ((await readPlistString(infoPlist, "CFBundleIconName")) != null) {
    await run(SYSTEM_TOOLS.plutil, ["-remove", "CFBundleIconName", infoPlist]);
  }
}
