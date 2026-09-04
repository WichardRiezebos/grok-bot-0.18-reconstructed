#!/usr/bin/env node
// Post-deploy verification for the hetzner web runtime.
// Usage: node scripts/verify-deploy.mjs [base-url]
const base = process.argv[2] ?? "http://100.83.5.113:8080";
const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

const health = await fetch(`${base}/health`).then(r => r.json()).catch(() => null);
check("health ok", health?.ok === true, JSON.stringify(health)?.slice(0, 160));
check("coordinator alive", health?.coordinator?.alive === true);

const index = await fetch(`${base}/`).then(r => r.text()).catch(() => "");
check("0.39 entry chunk", index.includes("index-BhgGiPaq.js"));

const shim = await fetch(`${base}/__grok_bot/shim.js`).then(r => r.text()).catch(() => "");
check("shim has noteRendererAlive", shim.includes("noteRendererAlive"));
check("shim has upgradeSchedule", shim.includes("upgradeSchedule"));
check("shim hides stop button", shim.includes("sand-prompt-session-strip"));

const debug = await fetch(`${base}/debug/bots`).then(r => r.json()).catch(e => ({ error: String(e) }));
const models = debug?.inference?.models;
check("think = gemini-3.7-flash", models?.think === "google/gemini-3.7-flash", JSON.stringify(models));
check("drive = claude-haiku-4.5", models?.drive === "anthropic/claude-haiku-4.5");

let failed = 0;
for (const { name, ok, detail } of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}
console.log(failed === 0 ? "\nALL GREEN" : `\n${failed} FAILING`);
process.exit(failed === 0 ? 0 : 1);
