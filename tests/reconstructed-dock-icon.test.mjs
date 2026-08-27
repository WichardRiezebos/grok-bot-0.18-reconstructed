import assert from "node:assert/strict";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import test from "node:test";

import {
  badgeDockIconPng,
  MIN_BADGE_EDGE,
  resolveDockIconFileName,
} from "../scripts/lib/reconstructed-dock-icon.mjs";

const Jimp = createJimp({ formats: [png] });

async function solidPng(width, height, r, g, b) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
    data[index + 3] = 255;
  }
  return await Jimp.fromBitmap({ data, width, height }).getBuffer("image/png");
}

function pixel(image, x, y) {
  const index = (y * image.bitmap.width + x) * 4;
  return {
    r: image.bitmap.data[index],
    g: image.bitmap.data[index + 1],
    b: image.bitmap.data[index + 2],
    a: image.bitmap.data[index + 3],
  };
}

test("resolveDockIconFileName appends .icns and falls back to electron.icns", () => {
  assert.equal(resolveDockIconFileName(null), "electron.icns");
  assert.equal(resolveDockIconFileName("  "), "electron.icns");
  assert.equal(resolveDockIconFileName("electron"), "electron.icns");
  assert.equal(resolveDockIconFileName("electron.icns"), "electron.icns");
  assert.equal(resolveDockIconFileName("Contents/Resources/Grok Bot.icns"), "Grok Bot.icns");
});

test("badgeDockIconPng paints a blue asterisk in the top-right and leaves the center unchanged", async () => {
  const size = 128;
  const original = await solidPng(size, size, 20, 20, 20);
  const badged = await badgeDockIconPng(original);
  const image = await Jimp.fromBuffer(badged);
  assert.equal(image.bitmap.width, size);
  assert.equal(image.bitmap.height, size);

  const center = pixel(image, 64, 64);
  assert.equal(center.r, 20);
  assert.equal(center.g, 20);
  assert.equal(center.b, 20);
  assert.equal(center.a, 255);

  const badge = pixel(image, Math.round(size * 0.78), Math.round(size * 0.22));
  assert.ok(badge.b > badge.r, `top-right pixel should be blue-dominant, got ${JSON.stringify(badge)}`);
  assert.ok(badge.b > 150, `top-right pixel should be bright blue, got ${JSON.stringify(badge)}`);
  assert.ok(badge.g > 80, `top-right pixel should keep the asterisk green channel, got ${JSON.stringify(badge)}`);
});

test("badgeDockIconPng leaves icons smaller than 32px unchanged", async () => {
  const original = await solidPng(16, 16, 20, 20, 20);
  const badged = await badgeDockIconPng(original);
  const image = await Jimp.fromBuffer(badged);
  assert.equal(image.bitmap.width, 16);
  const sample = pixel(image, Math.round(16 * 0.78), Math.round(16 * 0.22));
  assert.equal(sample.r, 20);
  assert.equal(sample.g, 20);
  assert.equal(sample.b, 20);
  assert.ok(MIN_BADGE_EDGE === 32);
});
