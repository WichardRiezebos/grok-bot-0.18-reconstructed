export const SAND_UI_DRIVER_VERSION = 3;
export const SAND_UI_DRIVER_BOX_DIR = "/tmp/.sand-ui";
export const SAND_UI_DRIVER_BOX_PATH = `${SAND_UI_DRIVER_BOX_DIR}/driver-v${String(SAND_UI_DRIVER_VERSION)}.mjs`;
export const SAND_UI_RESULT_MARKER = "__SAND_UI_RESULT__";
export const SAND_UI_CDP_PORT_BASE = 9_222;

export const SAND_UI_DRIVER_SOURCE = `
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const RESULT_MARKER = "__SAND_UI_RESULT__";
const STATE_DIR = "/tmp/.sand-ui";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reply(ok, text) {
  process.stdout.write(RESULT_MARKER + JSON.stringify({ ok, text }) + "\\n");
}

function fail(text) {
  reply(false, text);
}

function statePath(display) {
  return STATE_DIR + "/states-" + String(display) + ".json";
}

function loadStore(display) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(display), "utf8"));
    if (parsed && typeof parsed === "object") {
      return {
        next: typeof parsed.next === "number" ? parsed.next : 1,
        states: parsed.states && typeof parsed.states === "object" ? parsed.states : {},
        roots: parsed.roots && typeof parsed.roots === "object" ? parsed.roots : {},
      };
    }
  } catch {}
  return { next: 1, states: {}, roots: {} };
}

function saveStore(display, store) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = statePath(display) + "." + String(process.pid) + ".tmp";
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, statePath(display));
}

async function openCdpSocket(wsUrl) {
  let WS = globalThis.WebSocket;
  if (WS === undefined) {
    try {
      WS = createRequire(import.meta.url)("playwright-core/lib/utilsBundle").ws;
    } catch {
      return undefined;
    }
  }
  let ws;
  try {
    ws = new WS(wsUrl);
  } catch {
    return undefined;
  }
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    const ok = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const bad = () => {
      clearTimeout(timer);
      resolve(false);
    };
    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", ok);
      ws.addEventListener("error", bad);
    } else {
      ws.on("open", ok);
      ws.on("error", bad);
    }
  });
  if (!opened) {
    try { ws.close(); } catch {}
    return undefined;
  }
  let nextId = 1;
  const pending = new Map();
  const onMessage = (data) => {
    let msg;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data.data ?? data));
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  if (typeof ws.addEventListener === "function") ws.addEventListener("message", onMessage);
  else ws.on("message", onMessage);
  const send = (method, params, sessionId, timeoutMs) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      const payload = { id, method, params: params !== undefined ? params : {} };
      if (sessionId !== undefined) payload.sessionId = sessionId;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve(undefined);
      }
    });
  return {
    send,
    close: () => {
      try { ws.close(); } catch {}
    },
  };
}

async function listPages(port) {
  const res = await fetch("http://127.0.0.1:" + String(port) + "/json/list", { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error("CDP list failed (" + res.status + ")");
  const targets = await res.json();
  return (Array.isArray(targets) ? targets : []).filter((t) => t && t.type === "page");
}

async function versionWs(port) {
  const res = await fetch("http://127.0.0.1:" + String(port) + "/json/version", { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error("CDP version failed (" + res.status + ")");
  const body = await res.json();
  if (typeof body.webSocketDebuggerUrl !== "string" || body.webSocketDebuggerUrl.length === 0) {
    throw new Error("CDP did not return a debugger URL.");
  }
  return body.webSocketDebuggerUrl;
}

function axValue(node, key) {
  const field = node && node[key];
  if (field && typeof field.value === "string") return field.value;
  if (typeof field === "string") return field;
  return "";
}

function interesting(node) {
  if (!node || node.ignored === true) return false;
  const role = axValue(node, "role");
  if (["StaticText", "InlineTextBox", "LineBreak", "none", "Ignored"].includes(role)) return false;
  const name = axValue(node, "name");
  if (name.trim().length > 0) return true;
  return ["heading", "button", "link", "textbox", "searchbox", "checkbox", "combobox", "menuitem", "tab", "WebArea", "document"].includes(role);
}

function foldTree(nodes, maxDepth) {
  const byId = new Map();
  for (const node of nodes) byId.set(node.nodeId, node);
  const root = nodes.find((n) => !nodes.some((p) => Array.isArray(p.childIds) && p.childIds.includes(n.nodeId))) ?? nodes[0];
  const out = [];
  let next = 1;
  const walk = (node, depth, parentRef) => {
    if (node == null || depth > maxDepth) return;
    const keep = interesting(node);
    const ref = keep ? "@e" + String(next++) : undefined;
    if (keep && ref !== undefined) {
      out.push({
        ref,
        role: axValue(node, "role") || "generic",
        name: axValue(node, "name"),
        value: axValue(node, "value"),
        parent: parentRef,
        backendDOMNodeId: typeof node.backendDOMNodeId === "number" ? node.backendDOMNodeId : undefined,
        pictureOnly: axValue(node, "role") === "image" && axValue(node, "name").trim().length === 0,
      });
    }
    const kids = Array.isArray(node.childIds) ? node.childIds : [];
    for (const id of kids) walk(byId.get(id), depth + (keep ? 1 : 0), ref ?? parentRef);
  };
  walk(root, 0, undefined);
  return out.slice(0, 120);
}

function renderOutline(nodes, title, url, stateId, root) {
  const lines = [
    "root " + root + (title.length > 0 ? ' title="' + title.replaceAll('"', "'") + '"' : "") + (url.length > 0 ? " url=" + url : ""),
    "stateId " + stateId,
    'document.title "' + title.replaceAll('"', "'") + '"',
  ];
  for (const node of nodes) {
    const indent = node.parent == null ? "  " : "    ";
    const bits = [indent + node.ref, node.role];
    if (node.name) bits.push('"' + node.name.replaceAll('"', "'") + '"');
    if (node.value) bits.push("value=" + JSON.stringify(node.value).slice(0, 80));
    if (node.pictureOnly) bits.push("pictureOnly");
    lines.push(bits.join(" "));
  }
  if (nodes.length === 0) lines.push("  (empty outline)");
  return lines.join("\\n");
}

async function withPage(port, targetId, fn) {
  const socket = await openCdpSocket(await versionWs(port));
  if (socket === undefined) throw new Error("Could not open a CDP socket. Is box Chrome running?");
  try {
    const attached = await socket.send("Target.attachToTarget", { targetId, flatten: true }, undefined, 4000);
    const sessionId = attached && attached.result ? attached.result.sessionId : undefined;
    if (typeof sessionId !== "string") throw new Error("Could not attach to the Chrome page.");
    return await fn(socket, sessionId);
  } finally {
    socket.close();
  }
}

async function capture(port, targetId, maxDepth) {
  return await withPage(port, targetId, async (socket, sessionId) => {
    await socket.send("Accessibility.enable", {}, sessionId, 2000);
    const tree = await socket.send("Accessibility.getFullAXTree", {}, sessionId, 8000);
    const nodes = tree && tree.result && Array.isArray(tree.result.nodes) ? tree.result.nodes : [];
    const evaluated = await socket.send(
      "Runtime.evaluate",
      { expression: "JSON.stringify({ title: document.title, url: location.href })", returnByValue: true },
      sessionId,
      3000,
    );
    let title = "";
    let url = "";
    try {
      const raw = evaluated && evaluated.result && evaluated.result.result ? evaluated.result.result.value : "";
      const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
      title = typeof parsed.title === "string" ? parsed.title : "";
      url = typeof parsed.url === "string" ? parsed.url : "";
    } catch {}
    return { nodes: foldTree(nodes, maxDepth), title, url };
  });
}

function pickTarget(pages, store, root) {
  if (typeof root === "string" && root.length > 0) {
    const mapped = store.roots[root];
    if (mapped) {
      const hit = pages.find((p) => p.id === mapped.targetId);
      if (hit) return { root, page: hit };
    }
  }
  const visible = pages.find((p) => typeof p.title === "string" && p.title.length > 0) ?? pages[0];
  if (visible == null) return undefined;
  const existing = Object.entries(store.roots).find(([, value]) => value.targetId === visible.id);
  const assigned = existing ? existing[0] : "@r" + String(Object.keys(store.roots).length + 1);
  return { root: assigned, page: visible };
}

function saveObservation(store, display, root, page, captured) {
  const stateId = "S" + String(store.next++);
  store.roots[root] = { targetId: page.id, title: captured.title, url: captured.url || page.url || "" };
  store.states[stateId] = {
    root,
    targetId: page.id,
    title: captured.title,
    url: captured.url || page.url || "",
    nodes: captured.nodes,
  };
  saveStore(display, store);
  return { stateId, text: renderOutline(captured.nodes, captured.title, captured.url || page.url || "", stateId, root) };
}

async function clickNode(socket, sessionId, backendDOMNodeId) {
  const quads = await socket.send("DOM.getContentQuads", { backendNodeId: backendDOMNodeId }, sessionId, 3000);
  const list = quads && quads.result && Array.isArray(quads.result.quads) ? quads.result.quads[0] : undefined;
  if (!Array.isArray(list) || list.length < 8) throw new Error("No clickable box for that @e ref.");
  const xs = [list[0], list[2], list[4], list[6]];
  const ys = [list[1], list[3], list[5], list[7]];
  const x = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
  const y = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
  await socket.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId, 2000);
  await socket.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId, 2000);
}

async function typeInto(socket, sessionId, backendDOMNodeId, text, replace) {
  if (typeof backendDOMNodeId === "number") {
    await socket.send("DOM.focus", { backendNodeId: backendDOMNodeId }, sessionId, 2000);
  }
  if (replace === true) {
    await socket.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", modifiers: 2 }, sessionId, 1000);
    await socket.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", modifiers: 2 }, sessionId, 1000);
    await socket.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace" }, sessionId, 1000);
    await socket.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace" }, sessionId, 1000);
  }
  await socket.send("Input.insertText", { text }, sessionId, 3000);
}

async function keypress(socket, sessionId, key) {
  await socket.send("Input.dispatchKeyEvent", { type: "keyDown", key }, sessionId, 1000);
  await socket.send("Input.dispatchKeyEvent", { type: "keyUp", key }, sessionId, 1000);
}

async function run(request) {
  const op = request.op;
  const display = request.display ?? 0;
  const port = request.cdpPort;
  const args = request.args && typeof request.args === "object" ? request.args : {};
  if (op === "launch_browser") {
    throw new Error("launch_browser is disabled. Use box_chrome to open the existing box Chrome window.");
  }
  let pages;
  try {
    pages = await listPages(port);
  } catch (error) {
    throw new Error(
      "No Chrome page on this desktop (CDP " + String(port) + "). Call box_chrome with the destination URL. Never launch_browser. " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const store = loadStore(display);
  if (op === "find_roots") {
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const lines = ["CDP pages on this agent's box Chrome (do not launch_browser):"];
    store.roots = {};
    let i = 1;
    for (const page of pages) {
      const title = typeof page.title === "string" ? page.title : "";
      const url = typeof page.url === "string" ? page.url : "";
      if (query.length > 0 && !title.toLowerCase().includes(query) && !url.toLowerCase().includes(query)) continue;
      const root = "@r" + String(i++);
      store.roots[root] = { targetId: page.id, title, url };
      lines.push(root + ' title="' + title.replaceAll('"', "'") + '" url=' + url);
    }
    saveStore(display, store);
    if (i === 1) lines.push("No matching pages. Call box_chrome if Chrome is not visible.");
    else lines.push('Call observe_ui({ root: "@r1" }) and quote only names from that outline.');
    return lines.join("\\n");
  }
  if (op === "search_ui") {
    const stateId = typeof args.stateId === "string" ? args.stateId : "";
    const state = store.states[stateId];
    if (state == null) throw new Error("Unknown or expired stateId. Call observe_ui again.");
    const text = typeof args.text === "string" ? args.text.toLowerCase() : "";
    const role = typeof args.role === "string" ? args.role.toLowerCase() : "";
    if (text.length === 0 && role.length === 0) throw new Error("search_ui needs text or role.");
    const hits = state.nodes.filter((node) => {
      const name = String(node.name || "").toLowerCase();
      const value = String(node.value || "").toLowerCase();
      const nodeRole = String(node.role || "").toLowerCase();
      const textOk = text.length === 0 || name.includes(text) || value.includes(text);
      const roleOk = role.length === 0 || nodeRole === role || nodeRole.includes(role);
      return textOk && roleOk;
    });
    const lines = ["stateId " + stateId + " matches " + String(hits.length) + ":"];
    for (const node of hits.slice(0, 30)) {
      lines.push("  " + node.ref + " " + node.role + (node.name ? ' "' + node.name.replaceAll('"', "'") + '"' : ""));
    }
    return lines.join("\\n");
  }
  if (op === "observe_ui" || op === "wait_for") {
    const maxDepth = typeof args.maxDepth === "number" && args.maxDepth > 0 ? Math.min(args.maxDepth, 12) : 8;
    const needle = typeof args.text === "string" ? args.text : "";
    const timeoutMs = typeof args.timeoutMs === "number" ? Math.min(Math.max(args.timeoutMs, 0), 30_000) : op === "wait_for" ? 8_000 : 0;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const picked = pickTarget(pages, store, typeof args.root === "string" ? args.root : undefined);
      if (picked == null) throw new Error("No Chrome page to observe. Call box_chrome first. Never launch_browser.");
      const captured = await capture(port, picked.page.id, maxDepth);
      const hay = (captured.title + "\\n" + captured.nodes.map((n) => n.name + " " + n.value).join("\\n")).toLowerCase();
      const present = needle.length === 0 || hay.includes(needle.toLowerCase());
      if (op === "observe_ui" || present || Date.now() >= deadline) {
        const saved = saveObservation(store, display, picked.root, picked.page, captured);
        if (op === "wait_for" && needle.length > 0 && !present) {
          throw new Error("wait_for timed out for " + JSON.stringify(needle) + ". Last outline:\\n" + saved.text);
        }
        return saved.text;
      }
      await sleep(400);
      pages = await listPages(port);
    }
  }
  if (op === "act_ui") {
    const stateId = typeof args.stateId === "string" ? args.stateId : "";
    const state = store.states[stateId];
    if (state == null) throw new Error("Unknown or expired stateId. Call observe_ui again.");
    const actions = Array.isArray(args.actions) ? args.actions : [];
    if (actions.length === 0) throw new Error("act_ui needs actions.");
    await withPage(port, state.targetId, async (socket, sessionId) => {
      for (const step of actions) {
        const action = step && typeof step.action === "string" ? step.action : "";
        const ref = step && typeof step.ref === "string" ? step.ref : "";
        const node = ref.length > 0 ? state.nodes.find((n) => n.ref === ref) : undefined;
        if (action === "press" || action === "click") {
          if (node == null) throw new Error("Unknown ref " + ref + " for " + stateId);
          if (typeof step.x === "number" && typeof step.y === "number") {
            await socket.send("Input.dispatchMouseEvent", { type: "mousePressed", x: step.x, y: step.y, button: "left", clickCount: 1 }, sessionId, 2000);
            await socket.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: step.x, y: step.y, button: "left", clickCount: 1 }, sessionId, 2000);
          } else if (typeof node.backendDOMNodeId === "number") {
            await clickNode(socket, sessionId, node.backendDOMNodeId);
          } else {
            throw new Error(ref + " is not clickable (pictureOnly or no DOM node). Use Computer only as a last resort.");
          }
        } else if (action === "setText" || action === "typeText") {
          const text = typeof step.text === "string" ? step.text : "";
          await typeInto(socket, sessionId, node && node.backendDOMNodeId, text, action === "setText");
        } else if (action === "keypress") {
          await keypress(socket, sessionId, typeof step.key === "string" ? step.key : "Enter");
        } else if (action === "scroll") {
          await socket.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 400 }, sessionId, 2000);
        } else {
          throw new Error("Unsupported act_ui action: " + action);
        }
      }
    });
    const picked = pickTarget(pages, store, state.root);
    if (picked == null) throw new Error("Page gone after act_ui.");
    const captured = await capture(port, picked.page.id, 8);
    return saveObservation(store, display, picked.root, picked.page, captured).text;
  }
  throw new Error("Unknown UI op: " + op);
}

const encoded = process.argv[2];
if (typeof encoded !== "string" || encoded.length === 0) {
  fail("UI driver needs a base64 request.");
  process.exit(1);
}
try {
  const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const text = await run(request);
  reply(true, text);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;
