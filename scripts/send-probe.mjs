#!/usr/bin/env node
const port = process.env.PROBE_PORT ?? "8123";
const agentId = process.env.PROBE_AGENT ?? "";
const prompt = process.env.PROBE_PROMPT ?? "probe ping, one word";
let sent = false;
const requestId = `probe-${Date.now()}`;
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const started = Date.now();
const fail = (message) => { console.error(`probe FAIL ${Math.round((Date.now() - started) / 1000)}s ${message}`); process.exit(1); };
const timer = setTimeout(() => fail("no reply within 100s"), 100_000);
socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ kind: "coordinator", frame: { kind: "lifecycle", phase: "hello", protocolVersion: 1 } }));
});
socket.addEventListener("message", (event) => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  if (message.kind === "hello-ok" && !sent) {
    sent = true;
    socket.send(JSON.stringify({ kind: "coordinator", frame: { kind: "request", requestId, method: "sendPrompt", args: { agentId, prompt, clientNonce: requestId } } }));
    return;
  }
  if (message.kind === "rpc-ok") return;
  if (message.kind === "coordinator" && message.frame?.kind === "reply" && message.frame?.requestId === requestId) {
    clearTimeout(timer);
    const outcome = message.frame.outcome ?? {};
    console.log(`probe OK ${Math.round((Date.now() - started) / 1000)}s status=${outcome.status ?? "?"} ${JSON.stringify(outcome.value ?? outcome.failure ?? {}).slice(0, 140)}`);
    process.exit(0);
  }
});
socket.addEventListener("error", () => fail("websocket error"));
socket.addEventListener("close", (event) => { if (event.code !== 1000 && Date.now() - started > 1000) fail(`websocket closed ${event.code}`); });
