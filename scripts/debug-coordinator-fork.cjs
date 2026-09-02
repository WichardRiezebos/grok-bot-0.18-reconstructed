const { fork } = require("node:child_process");

const CONTROL = "coordinator-control";
const PROTO = 1;
const bootstrap = JSON.stringify({
  processConfig: { appVersion: "debug", isPackaged: true, dataDir: "/tmp/coord-debug" },
});

const child = fork("/app/node-agent-coordinator/main.cjs", [`--bootstrap=${bootstrap}`], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: process.env,
});

child.stdout?.on("data", (chunk) => process.stdout.write(`[stdout] ${chunk}`));
child.stderr?.on("data", (chunk) => process.stderr.write(`[stderr] ${chunk}`));
child.on("exit", (code, signal) => {
  console.log(`[exit] code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

const reply = (requestId, value) => {
  child.send({ channel: CONTROL, frame: { kind: "reply", requestId, outcome: { status: "ok", value } } });
};
const fail = (requestId, message) => {
  child.send({ channel: CONTROL, frame: { kind: "reply", requestId, outcome: { status: "failed", failure: { code: "err", message } } } });
};

child.on("message", (message) => {
  if (message == null || typeof message !== "object") return;
  if (message.channel !== CONTROL) {
    console.log("[data]", JSON.stringify(message).slice(0, 160));
    return;
  }
  const frame = message.frame;
  if (frame == null || typeof frame !== "object") return;
  const tag = frame.kind === "request" ? frame.method : frame.phase ?? frame.family ?? frame.kind;
  console.log("[ctrl]", frame.kind, tag);
  if (frame.kind === "lifecycle" && frame.phase === "hello") {
    child.send({ channel: CONTROL, frame: { kind: "lifecycle", phase: "ready", protocolVersion: PROTO } });
    return;
  }
  if (frame.kind === "lifecycle" && frame.phase === "shutdown") {
    console.log("[ctrl] shutdown", frame.reason, frame.detail);
    return;
  }
  if (frame.kind !== "request") {
    if (frame.kind === "event") console.log("[event]", frame.family);
    return;
  }
  const method = frame.method;
  if (method === "resolveGatewayConnection") {
    reply(frame.requestId, { baseUrl: process.env.SAND_HOST_GATEWAY_URL, token: process.env.SAND_GATEWAY_TOKEN });
    return;
  }
  if (method === "mintLocalExecDaemonCredential") {
    reply(frame.requestId, null);
    return;
  }
  if (method === "spawnLocalExecDaemon") {
    fail(frame.requestId, "spawn unavailable in docker");
    return;
  }
  if (method === "isProcessAlive") {
    reply(frame.requestId, false);
    return;
  }
  if (method === "getProcessIdentity") {
    reply(frame.requestId, null);
    return;
  }
  if (method === "terminateProcess") {
    reply(frame.requestId, { terminated: false });
    return;
  }
  if (method === "waitLocalExecDaemonExit") {
    fail(frame.requestId, "no daemon");
    return;
  }
  if (method === "listRoutedMcpTools") {
    reply(frame.requestId, []);
    return;
  }
  if (method.startsWith("report") || method === "getRpcTraceWindowTraceparent") {
    reply(frame.requestId, null);
    return;
  }
  fail(frame.requestId, `unknown ${method}`);
});

setTimeout(() => console.log("[parent alive 15s]"), 15_000);
