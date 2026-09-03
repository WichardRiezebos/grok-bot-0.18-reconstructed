import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extractAll } from "@electron/asar";
import {
  webArchivedDmg,
  webCachedDmg,
  webDmgSha256,
  webDmgUrl,
  webRendererVersion,
  webShippedRendererDir,
  webShippedRendererProvenance,
  webUpstreamAsarSha256,
} from "./lib/config.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";
import { run } from "./lib/process.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function sourceDmg() {
  if (await exists(webArchivedDmg)) {
    const archivedDigest = await sha256(webArchivedDmg);
    if (archivedDigest !== webDmgSha256) {
      throw new Error(`Archived web renderer DMG checksum mismatch: expected ${webDmgSha256}, got ${archivedDigest}. Run git lfs pull before bootstrapping.`);
    }
    await mkdir(path.dirname(webCachedDmg), { recursive: true });
    if (await exists(webCachedDmg) && (await sha256(webCachedDmg)) === webDmgSha256) {
      return webCachedDmg;
    }
    console.log(`Using archived release ${webArchivedDmg}`);
    await copyFile(webArchivedDmg, webCachedDmg);
    return webCachedDmg;
  }
  await mkdir(path.dirname(webCachedDmg), { recursive: true });
  if (await exists(webCachedDmg)) {
    const digest = await sha256(webCachedDmg);
    if (digest === webDmgSha256) return webCachedDmg;
    await rm(webCachedDmg, { force: true });
  }
  console.log(`Downloading ${webDmgUrl}`);
  const response = await fetch(webDmgUrl, { redirect: "follow" });
  if (!response.ok || response.body == null) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const partial = `${webCachedDmg}.partial`;
  await rm(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
  const digest = await sha256(partial);
  if (digest !== webDmgSha256) {
    await rm(partial, { force: true });
    throw new Error(`Web renderer DMG checksum mismatch: expected ${webDmgSha256}, got ${digest}`);
  }
  await rename(partial, webCachedDmg);
  return webCachedDmg;
}

async function evaluateStagedRenderer() {
  const provenance = JSON.parse(await readFile(webShippedRendererProvenance, "utf8"));
  if (provenance.version !== webRendererVersion || provenance.upstreamAsarSha256 !== webUpstreamAsarSha256) {
    console.log(`Staged renderer provenance does not match the pinned ${webRendererVersion} web payload.`);
    return { ok: false, files: null, provenance: null };
  }
  const files = provenance.files ?? [];
  if (files.length === 0) {
    console.log("Staged renderer provenance has no file inventory; restaging.");
    return { ok: false, files, provenance };
  }
  for (const file of files) {
    const target = path.join(webShippedRendererDir, file.path.replace(/^dist\/renderer\//, ""));
    if (!(await exists(target))) {
      console.log(`Staged renderer is missing ${file.path}; restaging.`);
      return { ok: false, files, provenance };
    }
    const bytes = await readFile(target);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256) {
      console.log(`Staged renderer drifted for ${file.path}; restaging.`);
      return { ok: false, files, provenance };
    }
  }
  return { ok: true, files, provenance };
}

async function stageRendererFromDmg(dmg) {
  const mountRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-036-mount-"));
  let attached = false;
  const asarTemp = await mkdtemp(path.join(tmpdir(), "grok-bot-036-asar-"));
  try {
    await run(SYSTEM_TOOLS.hdiutil, ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, dmg]);
    attached = true;
    const resources = path.join(mountRoot, "Grok Bot.app", "Contents", "Resources");
    const asar = path.join(resources, "app.asar");
    const asarBytes = await readFile(asar);
    const actualAsarSha256 = createHash("sha256").update(asarBytes).digest("hex");
    if (actualAsarSha256 !== webUpstreamAsarSha256) {
      throw new Error(`Web renderer upstream app.asar checksum mismatch: expected ${webUpstreamAsarSha256}, got ${actualAsarSha256}`);
    }
    extractAll(asar, asarTemp);
    const rendererSource = path.join(asarTemp, "dist", "renderer");
    const files = [];
    async function walk(dir, prefix) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), relative);
          continue;
        }
        if (!entry.isFile()) throw new Error(`unexpected non-regular file in renderer payload: ${relative}`);
        const bytes = await readFile(path.join(dir, entry.name));
        files.push({
          path: `dist/renderer/${relative}`,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
    await walk(rendererSource, "");
    files.sort((left, right) => left.path.localeCompare(right.path));
    const indexHtml = files.find((file) => file.path === "dist/renderer/index.html");
    if (indexHtml == null) throw new Error("Upstream app.asar is missing dist/renderer/index.html");

    await rm(webShippedRendererDir, { recursive: true, force: true });
    await mkdir(webShippedRendererDir, { recursive: true });
    for (const entry of await readdir(rendererSource, { withFileTypes: true })) {
      await cp(path.join(rendererSource, entry.name), path.join(webShippedRendererDir, entry.name), { recursive: true });
    }
    const htmlText = (await readFile(path.join(webShippedRendererDir, "index.html"))).toString("utf8");
    const entryChunk = htmlText.match(/assets\/(index-[^"']+\.js)/)?.[1];
    const entryCss = htmlText.match(/assets\/(index-[^"']+\.css)/)?.[1];

    const provenance = {
      schemaVersion: 1,
      product: "Grok Bot",
      version: webRendererVersion,
      role: "web-dokploy-shipped-renderer",
      sourceType: "public-release-dmg",
      sourceUrl: webDmgUrl,
      dmgSha256: webDmgSha256,
      upstreamAsarSha256: webUpstreamAsarSha256,
      upstreamBundleId: "com.anysphere.sand",
      patchMode: "unpatched-stock-renderer",
      entryAssets: {
        indexHtml: "index.html",
        ...(entryChunk == null ? {} : { entryChunk: `assets/${entryChunk}` }),
        ...(entryCss == null ? {} : { entryCss: `assets/${entryCss}` }),
      },
      fileCount: files.length,
      files,
    };
    await writeFile(webShippedRendererProvenance, `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(`Staged web renderer ${webRendererVersion}: ${files.length} files (entry ${entryChunk ?? "?"})`);
  } finally {
    if (attached) await run(SYSTEM_TOOLS.hdiutil, ["detach", mountRoot]);
    await rm(mountRoot, { recursive: true, force: true });
    await rm(asarTemp, { recursive: true, force: true });
  }
}

if (await exists(webShippedRendererDir) && await exists(webShippedRendererProvenance)) {
  const staged = await evaluateStagedRenderer();
  if (staged.ok) {
    console.log(`Web renderer already staged and verified: ${webRendererVersion} (${staged.files.length} files).`);
    process.exit(0);
  }
}

const dmg = await sourceDmg();
await stageRendererFromDmg(dmg);
const revalidated = await evaluateStagedRenderer();
if (!revalidated.ok) throw new Error("Web renderer staging failed verification.");
console.log("Web renderer bootstrap complete.");
