import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shimPath = path.join(repoRoot, "source", "server-main", "web-shim.js");

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `function ${name} not found in web-shim.js`);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`function ${name} is unbalanced`);
}
test("refreshNoVncIframe never steals keyboard focus from the composer", async () => {
  const shimSource = await readFile(shimPath, "utf8");
  assert.doesNotMatch(shimSource, /rfb\.focus/, "the VNC refresh helper must not call rfb.focus()");
  assert.match(shimSource, /iframeLooksConnected\(iframe\)\);?\s*return/s, "a connected iframe must not be reloaded");
});

test("refreshNoVncIframe behavior: live rfb or connected iframe is untouched, dead iframe reloads and restores focus", async () => {
  const shimSource = await readFile(shimPath, "utf8");
  const code = `${extractFunction(shimSource, "iframeLooksConnected")}\n${extractFunction(shimSource, "refreshNoVncIframe")}\nreturn { iframeLooksConnected, refreshNoVncIframe };`;

  const build = (documentStub) => new Function("document", code)(documentStub);

  const makeIframe = (overrides = {}) => ({
    dataset: {},
    attrs: { src: "http://x/__grok_bot/vnc/fork/vnc.html?path=p&autoconnect=true" },
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    listeners: new Map(),
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    contentWindow: null,
    contentDocument: null,
    ...overrides,
  });

  const documentStub = { activeElement: null };

  // 1. A live rfb handle: nothing happens at all.
  const focused = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  const liveIframe = makeIframe({ contentWindow: { UI: { rfb: { scaleViewport: true, focusCalls: 0, focus() { this.focusCalls += 1; } } } } });
  documentStub.activeElement = focused;
  build(documentStub).refreshNoVncIframe(liveIframe);
  assert.equal(liveIframe.contentWindow.UI.rfb.focusCalls, 0, "rfb.focus must never be called");
  assert.equal(liveIframe.dataset.grokBotVncRefreshing, undefined);

  // 2. A connected iframe without rfb: not reloaded.
  const connectedIframe = makeIframe({
    contentDocument: { documentElement: { classList: { contains(name) { return name === "noVNC_connected"; } } } },
  });
  build(documentStub).refreshNoVncIframe(connectedIframe);
  assert.equal(connectedIframe.dataset.grokBotVncRefreshing, undefined, "connected iframe must not be reloaded");
  assert.equal(connectedIframe.attrs.src.includes("grokBotFb"), false);

  // 3. A dead iframe: reloaded once, and focus returns to the composer afterwards.
  const deadIframe = makeIframe();
  const refresh = build(documentStub).refreshNoVncIframe;
  const composer = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  documentStub.activeElement = composer;
  refresh(deadIframe);
  assert.equal(deadIframe.attrs.src.includes("grokBotFb="), true, "dead iframe is reloaded with a cache-bust param");
  assert.equal(deadIframe.dataset.grokBotVncRefreshing, "1");
  refresh(deadIframe);
  assert.equal([...deadIframe.attrs.src.matchAll(/grokBotFb=/g)].length, 1, "refresh while already refreshing must not stack reloads");

  deadIframe.listeners.get("load")();
  assert.equal(composer.focusCalls, 1, "after a forced reload, focus must return to the element the user was typing in");
  assert.equal(deadIframe.dataset.grokBotVncRefreshing, undefined);
});
