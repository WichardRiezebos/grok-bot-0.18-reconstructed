import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadEntry(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-profile-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return { module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("Gravatar URL is the SHA-256 of the trimmed lowercase email", async () => {
  const loaded = await loadEntry("source/shared/local-profile.ts");
  try {
    const { gravatarAvatarUrl, localProfilePictureUrl, normalizeLocalProfileEmail, resolveLocalProfile } = loaded.module;
    const email = "  Test@Example.COM ";
    const hash = createHash("sha256").update("test@example.com").digest("hex");
    assert.equal(normalizeLocalProfileEmail(email), "test@example.com");
    assert.equal(gravatarAvatarUrl(email), `https://www.gravatar.com/avatar/${hash}?s=160&d=identicon&r=g`);
    assert.equal(localProfilePictureUrl(email), gravatarAvatarUrl("test@example.com"));
    assert.equal(localProfilePictureUrl("not-an-email"), undefined);
    assert.deepEqual(resolveLocalProfile({ name: "  Ada Lovelace  ", email }), {
      name: "Ada Lovelace",
      email: "test@example.com",
    });
    assert.deepEqual(resolveLocalProfile({}), { name: "Local", email: "" });
  } finally {
    await loaded.dispose();
  }
});

test("settings store persists a local name and email", async () => {
  const loaded = await loadEntry("source/shared/node/settings/sand-settings-store.ts");
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-local-profile-settings-"));
  try {
    const store = new loaded.module.SandSettingsStore(path.join(directory, "settings.json"));
    store.setLocalProfileName("  Ada Lovelace  ");
    store.setLocalProfileEmail("  Test@Example.COM ");
    assert.equal(store.getLocalProfileName(), "Ada Lovelace");
    assert.equal(store.getLocalProfileEmail(), "test@example.com");
    store.setLocalProfileEmail("nope");
    assert.equal(store.getLocalProfileEmail(), undefined);
    store.setLocalProfileEmail("test@example.com");
    assert.equal(store.getLocalProfileEmail(), "test@example.com");
    store.setLocalProfileEmail("");
    assert.equal(store.getLocalProfileEmail(), undefined);
    const reloaded = new loaded.module.SandSettingsStore(path.join(directory, "settings.json"));
    assert.equal(reloaded.getLocalProfileName(), "Ada Lovelace");
    assert.equal(reloaded.getLocalProfileEmail(), undefined);
  } finally {
    await loaded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
