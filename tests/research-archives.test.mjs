import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const archiveRoot = path.join(repositoryRoot, "research-archives", "original", "0.18.0");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

test("preserved 0.18.0 installers match the exact public release inventory", async () => {
  const manifest = JSON.parse(await readFile(path.join(archiveRoot, "artifacts.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "product", "schemaVersion", "version"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, "Grok Bot");
  assert.equal(manifest.version, "0.18.0");
  assert.equal(manifest.artifacts.length, 2);

  for (const artifact of manifest.artifacts) {
    assert.deepEqual(
      Object.keys(artifact).sort(),
      ["architecture", "bytes", "path", "platform", "sha256", "sourceUrl"],
    );
    assert.match(artifact.path, /^(macos-arm64\/[^/]+\.dmg|windows-x64\/[^/]+\.exe)$/);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.match(artifact.sourceUrl, /^https:\/\/downloads\.cursor\.com\/grokbot\/stable\//);
    const file = path.join(archiveRoot, artifact.path);
    assert.ok(file.startsWith(`${archiveRoot}${path.sep}`));
    const metadata = await lstat(file);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.size, artifact.bytes, `${artifact.path} requires git lfs pull`);
    assert.equal(await sha256(file), artifact.sha256);
  }
});

test("bootstrap prefers the hash-pinned local archive before the network", async () => {
  const [attributes, config, bootstrap] = await Promise.all([
    readFile(path.join(repositoryRoot, ".gitattributes"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts", "lib", "config.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts", "bootstrap-runtime.mjs"), "utf8"),
  ]);
  assert.match(attributes, /research-archives\/original\/\*\*\/\*\.dmg filter=lfs diff=lfs merge=lfs -text/);
  assert.match(attributes, /research-archives\/original\/\*\*\/\*\.exe filter=lfs diff=lfs merge=lfs -text/);
  assert.match(config, /export const archivedDmg = path\.join\(repoRoot, "research-archives", "original", "0\.18\.0", "macos-arm64", "Grok_Bot_0\.18\.0\.dmg"\)/);
  assert.match(bootstrap, /const archivedDigest = await sha256\(archivedDmg\)/);
  assert.match(bootstrap, /if \(archivedDigest !== dmgSha256\)/);
  assert.match(bootstrap, /await copyFile\(archivedDmg, cachedDmg\)/);
  assert.ok(bootstrap.indexOf("await copyFile(archivedDmg, cachedDmg)") < bootstrap.indexOf("await fetch(dmgUrl"));
});

test("preserved 0.36.0 web renderer installers match the exact public release inventory", async () => {
  const webRoot = path.join(repositoryRoot, "research-archives", "original", "0.36.0");
  const manifest = JSON.parse(await readFile(path.join(webRoot, "artifacts.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, "Grok Bot");
  assert.equal(manifest.version, "0.36.0");
  assert.equal(manifest.artifacts.length, 2);
  assert.equal(manifest.upstreamAsar.sha256, "2ae381b92f9f19dd33b2404b512cedaa3d2e1b4a08640be088dc6a06b1cf98d3");

  for (const artifact of manifest.artifacts) {
    assert.match(artifact.path, /^(macos-arm64\/[^/]+\.dmg|windows-x64\/[^/]+\.exe)$/);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.match(artifact.sourceUrl, /^https:\/\/downloads\.cursor\.com\/grokbot\/stable\//);
    const file = path.join(webRoot, artifact.path);
    assert.ok(file.startsWith(`${webRoot}${path.sep}`));
    const metadata = await lstat(file);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.size, artifact.bytes, `${artifact.path} requires git lfs pull`);
    assert.equal(await sha256(file), artifact.sha256);
  }

  const [config, provenance] = await Promise.all([
    readFile(path.join(repositoryRoot, "scripts", "lib", "config.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "deploy", "control", "shipped-renderer-provenance.json"), "utf8"),
  ]);
  assert.match(config, /export const webRendererVersion = "0\.39\.0"/);
  assert.match(config, /export const webDmgSha256 = "345561547cceb3b83355cc578b38fdbce74f731500382a57385616d124d8cc12"/);
  const staged = JSON.parse(provenance);
  assert.equal(staged.version, "0.39.0");
  assert.equal(staged.dmgSha256, "345561547cceb3b83355cc578b38fdbce74f731500382a57385616d124d8cc12");
  assert.equal(staged.upstreamAsarSha256, "c5fe6e202ca58d5f890e90cbde6163b6cf3733b49a425a32d148bb58ffccbc3c");

  const bootstrapWeb = await readFile(path.join(repositoryRoot, "scripts", "bootstrap-web-renderer.mjs"), "utf8");
  assert.match(bootstrapWeb, /const archivedDigest = await sha256\(webArchivedDmg\)/);
  assert.ok(bootstrapWeb.indexOf("await copyFile(webArchivedDmg, webCachedDmg)") < bootstrapWeb.indexOf("await fetch(webDmgUrl"));

  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["web:bootstrap"], "node scripts/bootstrap-web-renderer.mjs");
});
