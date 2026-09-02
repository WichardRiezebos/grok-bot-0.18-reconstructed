#!/usr/bin/env node
import { stat, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TONES = {
  "turn-start": "\u001b[32m",
  "turn-finish": "\u001b[92m",
  "turn-supersede": "\u001b[33m",
  "turn-stop": "\u001b[31m\u001b[1m",
  "turn-timeout": "\u001b[31m\u001b[1m",
  "turn-error": "\u001b[31m\u001b[1m",
  "turn-abort": "\u001b[31m",
  "turn-retry": "\u001b[33m",
  "turn-deadline": "\u001b[33m",
  "prompt-part": "\u001b[35m",
  "tool-start": "\u001b[36m",
  "tool-finish": "\u001b[36m",
  "tool-error": "\u001b[31m",
  "stream": "\u001b[38;5;245m",
  "persist-error": "\u001b[31m",
  "box-handoff": "\u001b[36m",
  "send-to-agent": "\u001b[36m",
};
const RESET = "\u001b[0m";

export function parseTurnLogLine(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\S*) ([^\s]+) ([^\s]+) (.*)$/u.exec(line);
  if (match == null) return null;
  const at = new Date(match[1]);
  if (Number.isNaN(at.getTime())) return null;
  return { at, provider: match[2], agentId: match[3], message: match[4] };
}

export function classifyTurnLogMessage(message) {
  const first = message.split(" ")[0] ?? "";
  if (TONES[first] != null) return first;
  if (first.startsWith("tool-") || first === "box-chrome-auto" || first === "box-chrome-skip") return first.startsWith("tool-") ? first : "tool-start";
  if (first === "stream") return "stream";
  if (first === "discard-narration" || first === "prompt") return "stream";
  return "other";
}

export function renderTurnLogLine(parsed, now = new Date(), color = false) {
  void now;
  const kind = classifyTurnLogMessage(parsed.message);
  const stamp = parsed.at.toISOString().slice(11, 23);
  const body = `${stamp} ${parsed.agentId} ${parsed.message}`;
  if (!color) return body;
  const tone = TONES[kind] ?? "";
  return tone == null || tone.length === 0 ? body : `${tone}${body}${RESET}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveLogPath(input) {
  if (input != null && input.endsWith(".log")) return input;
  const base = input ?? process.env.GROK_BOT_DATA_DIR ?? join(process.cwd(), "data");
  return join(base, "routed-inference.log");
}

const IDLE_STEPS = [15, 30, 60, 120, 300, 600];

async function main() {
  const argv = process.argv.slice(2);
  const flags = {
    agent: "",
    color: process.stdout.isTTY === true,
    history: false,
    json: false,
  };
  let positional;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent") flags.agent = argv[++index] ?? "";
    else if (arg === "--json") flags.json = true;
    else if (arg === "--history") flags.history = true;
    else if (arg === "--no-color") flags.color = false;
    else if (arg === "--color") flags.color = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("usage: node scripts/turn-tail.mjs [fileOrDir/dataDir] [--agent id] [--history] [--json] [--no-color]\n");
      process.stdout.write("  tails routed-inference.log (default: $GROK_BOT_DATA_DIR or ./data), new lines only unless --history\n");
      return;
    }
    else positional = arg;
  }
  const logPath = resolveLogPath(positional);
  let print = async () => {};
  if (flags.json) print = async (line) => { process.stdout.write(`${line}\n`); };
  else print = async (line) => {
    const parsed = parseTurnLogLine(line);
    if (parsed == null) { process.stdout.write(`${line}\n`); return; }
    if (flags.agent.length > 0 && parsed.agentId !== flags.agent) return;
    process.stdout.write(`${renderTurnLogLine(parsed, new Date(), flags.color)}\n`);
  };
  let offset = 0;
  try {
    offset = (await stat(logPath)).size;
  } catch {
    process.stdout.write(`[turn-tail] no ${logPath} yet — waiting for the first routed turn\n`);
  }
  if (flags.history && offset > 0) {
    const text = await readFile(logPath, "utf8");
    for (const line of text.split("\n")) if (line.length > 0) await print(line);
    process.stdout.write("[turn-tail] history replayed, now tailing\n");
  }
  let reading = false;
  let remainder = "";
  const drain = async () => {
    if (reading) return;
    reading = true;
    try {
      const size = await stat(logPath).then((s) => s.size, () => 0);
      if (size < offset) {
        offset = 0;
        remainder = "";
        process.stdout.write("[turn-tail] log rotated\n");
      }
      if (size > offset) {
        const { open } = await import("node:fs/promises");
        const handle = await open(logPath, "r");
        try {
          const length = size - offset;
          const chunk = Buffer.alloc(length);
          await handle.read(chunk, 0, length, offset);
          offset = size;
          remainder += chunk.toString("utf8");
        } finally { await handle.close(); }
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) if (line.length > 0) await print(line);
      }
    } catch {} finally { reading = false; }
  };
  let idleMarked = 0;
  let lastLineAt = Date.now();
  const wrapPrint = print;
  print = async (line) => {
    lastLineAt = Date.now();
    idleMarked = 0;
    await wrapPrint(line);
  };
  setInterval(drain, 400);
  setInterval(() => {
    const idleSec = Math.round((Date.now() - lastLineAt) / 1000);
    const step = IDLE_STEPS.find((value) => idleSec >= value && idleMarked < value);
    if (step == null) return;
    idleMarked = step;
    if (!flags.json) process.stdout.write(`\u001b[33m[turn-tail] idle ${idleSec}s without routed events\u001b[0m\n`);
  }, 1000);
  void watch(join(logPath, ".."), { persistent: true });
  process.stdout.write(`[turn-tail] tailing ${logPath} — Ctrl+C to stop\n`);
  await new Promise(() => {});
}

const invokedPath = process.argv[1];
if (invokedPath != null && import.meta.url === pathToFileURL(invokedPath).href) await main();
