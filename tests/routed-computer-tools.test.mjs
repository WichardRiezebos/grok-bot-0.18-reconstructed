import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const cacheRoot = path.join(repoRoot, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(cacheRoot, "grok-routed-computer-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("routed computer catalog includes Computer and request_box_help", async () => {
  const loaded = await loadModule("source/shared/routed-computer-tools.ts");
  try {
    const tools = loaded.module.listRoutedComputerToolDefinitions();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "find_roots", "observe_ui", "search_ui", "act_ui", "wait_for", "box_chrome", "request_box_help", "Computer",
    ]);
    assert.equal(tools[0].providerIdentifier, "grok-bot-computer");
    assert.equal(loaded.module.isRoutedComputerTool(tools[0]), true);
    assert.equal(loaded.module.isRoutedUiTool("observe_ui"), true);
    assert.equal(loaded.module.isRoutedUiTool("launch_browser"), false);
    assert.equal(loaded.module.isRoutedComputerTool({ name: "Gmail_send", providerIdentifier: "plugin-gmail" }), false);
    const merged = loaded.module.mergeRoutedToolLists(tools, [{ name: "Gmail_send", providerIdentifier: "plugin-gmail" }]);
    assert.equal(merged[0].name, "find_roots");
    assert.equal(merged.some((tool) => tool.name === "Computer"), true);
    assert.equal(loaded.module.routedToolsIncludeComputer(merged), true);
    assert.equal(loaded.module.openAiStrictSchemaGap(loaded.module.ROUTED_COMPUTER_INPUT_SCHEMA), null);
    assert.equal(loaded.module.openAiStrictSchemaGap(loaded.module.ROUTED_BOX_HELP_INPUT_SCHEMA), null);
    assert.equal(loaded.module.openAiStrictSchemaGap(loaded.module.ROUTED_BOX_CHROME_INPUT_SCHEMA), null);
    assert.equal(loaded.module.openAiStrictSchemaGap(loaded.module.ROUTED_UI_OBSERVE_INPUT_SCHEMA), null);
    assert.equal(loaded.module.openAiStrictSchemaGap(loaded.module.ROUTED_UI_ACT_INPUT_SCHEMA), null);
    assert.equal(loaded.module.openAiStrictSchemaGap(loaded.module.ROUTED_UI_SEARCH_INPUT_SCHEMA), null);
    assert.equal(loaded.module.isRoutedComputerTool({ name: "box_chrome" }), true);
    assert.equal(loaded.module.extractRoutedBrowserUrl("order cheese from plus.nl in basket"), "https://plus.nl/");
    assert.equal(loaded.module.extractRoutedBrowserUrl("open https://www.plus.nl/s?search=kaas"), "https://www.plus.nl/s?search=kaas");
    assert.equal(loaded.module.extractRoutedBrowserUrl("just say hi"), undefined);
    assert.equal(loaded.module.turnNeedsRoutedComputer("hello"), false);
    assert.equal(loaded.module.turnNeedsRoutedComputer("plus.nl"), true);
    assert.equal(loaded.module.turnNeedsRoutedComputer("hello", true), false);
    assert.equal(loaded.module.turnNeedsRoutedComputer("click the cookie banner"), true);
    assert.equal(loaded.module.isRoutedBrowserOriginHomeUrl("https://plus.nl/"), true);
    assert.equal(loaded.module.isRoutedBrowserOriginHomeUrl("https://www.plus.nl/s?search=kaas"), false);
    assert.equal(loaded.module.shouldSkipRoutedBoxChromeReload("https://plus.nl/", true), true);
    assert.equal(loaded.module.shouldSkipRoutedBoxChromeReload("https://plus.nl/s?q=pasta", true), false);
    assert.equal(loaded.module.shouldSkipRoutedBoxChromeReload("https://plus.nl/", false), false);
    assert.equal(
      loaded.module.buildBoxChromeCommand("https://plus.nl/"),
      "{ xdotool search --onlyvisible --class box-chrome >/dev/null && exit 0; }; box-chrome 'https://plus.nl/' && timeout 25 xdotool search --sync --onlyvisible --class box-chrome >/dev/null",
    );
    assert.equal(
      loaded.module.buildBoxChromeCommand("https://plus.nl/", 2),
      "{ DISPLAY=:2 xdotool search --onlyvisible --class box-chrome >/dev/null && exit 0; }; DISPLAY=:2 box-chrome 'https://plus.nl/' && DISPLAY=:2 timeout 25 xdotool search --sync --onlyvisible --class box-chrome >/dev/null",
    );
    assert.equal(
      loaded.module.buildBoxChromeCommand("https://plus.nl/s?search=kaas"),
      "box-chrome 'https://plus.nl/s?search=kaas' && timeout 25 xdotool search --sync --onlyvisible --class box-chrome >/dev/null",
    );
    assert.ok(loaded.module.buildBoxChromeCommand(null).startsWith("{ xdotool search --onlyvisible --class box-chrome >/dev/null && exit 0; }; box-chrome --new-window && "));
    assert.equal(loaded.module.boxChromeDisplayPrefix(1), "DISPLAY=:1 ");
    assert.equal(loaded.module.boxChromeDisplayPrefix(undefined), "");
    assert.ok(loaded.module.ROUTED_COMPUTER_INPUT_SCHEMA.required.includes("x"));
    assert.ok(loaded.module.ROUTED_COMPUTER_INPUT_SCHEMA.required.includes("then"));
    assert.deepEqual(
      loaded.module.ROUTED_COMPUTER_INPUT_SCHEMA.properties.then.anyOf[0].items.required.sort(),
      Object.keys(loaded.module.ROUTED_COMPUTER_INPUT_SCHEMA.properties.then.anyOf[0].items.properties).sort(),
    );
  } finally {
    await loaded.dispose();
  }
});

test("routed SendToAgent catalog is native and OpenAI-strict", async () => {
  const loaded = await loadModule("source/shared/routed-agent-tools.ts");
  const computer = await loadModule("source/shared/routed-computer-tools.ts");
  try {
    const tools = loaded.module.listRoutedSendToAgentToolDefinitions();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "SendToAgent");
    assert.equal(tools[0].providerIdentifier, "grok-bot-agents");
    assert.equal(loaded.module.isRoutedSendToAgentTool(tools[0]), true);
    assert.equal(loaded.module.isRoutedSendToAgentTool({ name: "Gmail_send" }), false);
    assert.equal(computer.module.openAiStrictSchemaGap(loaded.module.ROUTED_SEND_TO_AGENT_INPUT_SCHEMA), null);
    assert.equal(loaded.module.parseRoutedSendToAgentArgs({ target_id: "agent-b", message: " hi " }).message, "hi");
    assert.equal(loaded.module.parseRoutedSendToAgentArgs({ target_id: "", message: "hi" }), null);
    assert.deepEqual(
      loaded.module.routedTeammatesOf(
        [{ id: "a", name: "Atlas" }, { id: "b", name: "Research" }, { id: "g", name: "Room", isGroup: true }],
        "a",
      ),
      [{ id: "b", name: "Research" }],
    );
  } finally {
    await loaded.dispose();
    await computer.dispose();
  }
});

test("routed computer results expose screenshot images for Codex and OpenRouter", async () => {
  const loaded = await loadModule("source/shared/routed-computer-tools.ts");
  try {
    const result = loaded.module.routedComputerMcpResult({
      text: "Computer action ran on the box desktop.",
      image: { data: "abc123", mimeType: "image/webp" },
    });
    const parts = loaded.module.routedComputerResultParts(result);
    assert.equal(parts.text, "Computer action ran on the box desktop.");
    assert.deepEqual(parts.image, { data: "abc123", mimeType: "image/webp" });
    const modelContent = loaded.module.routedToolResultModelContent(result);
    assert.deepEqual(modelContent, [
      { type: "text", text: "Computer action ran on the box desktop." },
      { type: "image", data: "abc123", mimeType: "image/webp" },
    ]);
    assert.equal(loaded.module.nextComputerScreenshotStreak(0, { action: "screenshot" }), 1);
    assert.equal(loaded.module.nextComputerScreenshotStreak(3, { action: "screenshot" }), 4);
    assert.equal(loaded.module.nextComputerScreenshotStreak(3, { action: "click", x: 10, y: 10 }), 0);
    assert.equal(loaded.module.routedComputerActionName({ action: "type", text: "plus.nl" }), "type");
    assert.equal(loaded.module.isCookieConsentBoxHelp("Click Accepteren on the cookie banner"), true);
    assert.equal(loaded.module.isCookieConsentBoxHelp("Accept cookies"), true);
    assert.equal(loaded.module.isCookieConsentBoxHelp("Sign in to Plus", "auth"), false);
    assert.equal(loaded.module.isCookieConsentBoxHelp("Approve the payment", "payment"), false);
    const loop = loaded.module.routedComputerMcpResult({
      text: loaded.module.computerScreenshotLoopMessage(),
      isError: true,
    });
    assert.deepEqual(loaded.module.openRouterToolResultContent(loop), [
      { type: "text", text: loaded.module.computerScreenshotLoopMessage() },
    ]);
    const plugin = { result: { case: "success", value: { subject: "Hello" } } };
    assert.deepEqual(loaded.module.openRouterToolResultContent(plugin), [
      { type: "text", text: JSON.stringify(plugin) },
    ]);
    assert.deepEqual(loaded.module.openRouterToolResultContent(result), modelContent);
    const codex = loaded.module.codexFunctionCallOutput("call-1", result);
    assert.equal(codex.type, "function_call_output");
    assert.equal(codex.call_id, "call-1");
    assert.equal(Array.isArray(codex.output), true);
    assert.equal(codex.output[1].type, "input_image");
    assert.match(codex.output[1].image_url, /^data:image\/webp;base64,abc123$/);
  } finally {
    await loaded.dispose();
  }
});

test("routed Computer execute is distinct from MCP and returns MCP-shaped image content", async () => {
  const loaded = await loadModule("source/host/routed-computer-exec.ts");
  try {
    const listed = loaded.module.listRoutedComputerToolDefinitions();
    assert.ok(listed.some((tool) => tool.name === "Computer"));
    const built = loaded.module.routedComputerActionsFromArgs({
      action: "click", x: 10, y: 20, x2: null, text: null, then: null, description: "Open Chrome",
    });
    assert.equal(built.actions[0].action.case, "click");
    assert.equal(built.actions.at(-1).action.case, "screenshot");
    assert.deepEqual(built.reported, { type: "click", x: 10, y: 20, button: "left", count: 1 });

    const events = [];
    const result = await loaded.module.executeRoutedComputerTool({
      box: { ensureReady: async () => ({}) },
      startHandoff: (request) => ({ kind: "started", requestId: "help-1", instruction: request.instruction }),
      emitComputerAction: (payload) => events.push(payload),
    }, {
      agentId: "agent-1",
      name: "request_box_help",
      args: { instruction: "Approve the payment", reason: "payment", domain: "plus.nl" },
    });
    assert.equal(result.result.case, "success");
    assert.match(result.result.value.content[0].content.value.text, /Handed the box to the user/);
    assert.deepEqual(result.result.value.handoff, { requestId: "help-1", instruction: "Approve the payment" });
    assert.equal(events.length, 0);

    const cookieCalls = [];
    const cookie = await loaded.module.executeRoutedComputerTool({
      box: { ensureReady: async () => ({}) },
      startHandoff: (request) => {
        cookieCalls.push(request);
        return { kind: "started", requestId: "cookie-1", instruction: request.instruction };
      },
    }, {
      agentId: "agent-1",
      name: "request_box_help",
      args: { instruction: "Click Accepteren on the cookie banner", reason: "other", domain: "plus.nl" },
    });
    assert.equal(cookie.result.case, "error");
    assert.match(cookie.result.value.error, /Cookie banners/);
    assert.equal(cookieCalls.length, 0);

    const unknown = await loaded.module.executeRoutedComputerTool({
      box: { ensureReady: async () => ({}) },
      startHandoff: () => ({ kind: "started", requestId: "x" }),
    }, { agentId: "agent-1", name: "not-a-tool", args: {} });
    assert.equal(unknown.result.case, "error");

    const launch = await loaded.module.executeRoutedComputerTool({
      box: { ensureReady: async () => ({}) },
      startHandoff: () => ({ kind: "started", requestId: "x" }),
    }, { agentId: "agent-1", name: "launch_browser", args: { url: "https://example.com" } });
    assert.equal(launch.result.case, "error");
    assert.match(launch.result.value.error, /box_chrome/);

    const shellCalls = [];
    const uiCalls = [];
    const chromeBox = (execute) => ({
      ensureReady: async () => ({
        remoteAccessor: { get: () => ({ execute }) },
      }),
      getAgentWindowIndex: () => 2,
    });
    const ui = await loaded.module.executeRoutedComputerTool({
      box: chromeBox(async (_ctx, args) => {
        uiCalls.push(args.command);
        return {
          result: {
            case: "success",
            value: { stdout: `__SAND_UI_RESULT__${JSON.stringify({ ok: true, text: 'document.title "Quote me"' })}` },
          },
        };
      }),
      startHandoff: () => ({ kind: "started", requestId: "x" }),
    }, { agentId: "agent-1", name: "observe_ui", args: { root: "@r1" } });
    assert.equal(ui.result.case, "success");
    assert.match(ui.result.value.content[0].content.value.text, /document\.title "Quote me"/);
    assert.equal(uiCalls.length, 1);
    assert.match(uiCalls[0], /\/tmp\/\.sand-ui\/driver-v3\.mjs/);
    assert.match(uiCalls[0], /DISPLAY=:2 /);
    assert.doesNotMatch(uiCalls[0], /box-chrome --new-window/);
    const chrome = await loaded.module.executeRoutedComputerTool({
      box: chromeBox(async (_ctx, args) => {
        shellCalls.push(args.command);
        return { result: { case: "success", value: {} } };
      }),
      startHandoff: () => ({ kind: "started", requestId: "x" }),
    }, { agentId: "agent-1", name: "box_chrome", args: { url: "https://plus.nl/" } });
    assert.equal(chrome.result.case, "success");
    assert.deepEqual(shellCalls, [
      "{ DISPLAY=:2 xdotool search --onlyvisible --class box-chrome >/dev/null && exit 0; }; DISPLAY=:2 box-chrome 'https://plus.nl/' && DISPLAY=:2 timeout 25 xdotool search --sync --onlyvisible --class box-chrome >/dev/null",
    ]);
    assert.match(chrome.result.value.content[0].content.value.text, /Opened Chrome/);
    assert.match(chrome.result.value.content[0].content.value.text, /Confirm with observe_ui/);
    assert.match(chrome.result.value.content[0].content.value.text, /window is now visible/);

    const chromeFail = await loaded.module.executeRoutedComputerTool({
      box: chromeBox(async () => ({ result: { case: "success", value: { exitCode: 124, stderr: "no window" } } })),
      startHandoff: () => ({ kind: "started", requestId: "x" }),
    }, { agentId: "agent-1", name: "box_chrome", args: { url: "https://plus.nl/" } });
    assert.equal(chromeFail.result.case, "error");
    assert.match(chromeFail.result.value.error, /exited with code 124/);
    assert.match(chromeFail.result.value.error, /no window/);
  } finally {
    await loaded.dispose();
  }
});

test("production parent Task catalog includes computerUse when the box has a desktop", async () => {
  const loaded = await loadModule("source/host/production-subagent-configs.ts");
  try {
    const none = loaded.module.productionParentSubagentConfigs({ remoteBoxHasDesktop: false, browserUseOffered: false });
    assert.deepEqual(none, []);
    const computer = loaded.module.productionParentSubagentConfigs({ remoteBoxHasDesktop: true, browserUseOffered: false });
    assert.equal(computer.length, 1);
    assert.equal(computer[0].subagent_type.type.value.name, "computerUse");
    const both = loaded.module.productionParentSubagentConfigs({ remoteBoxHasDesktop: true, browserUseOffered: true });
    assert.deepEqual(both.map((config) => config.subagent_type.type.value.name), ["computerUse", "browserUse"]);
  } finally {
    await loaded.dispose();
  }
});

test("ui driver observes CDP accessibility, not screenshots", async () => {
  const loaded = await loadModule("source/host/runner/tools/sand-ui-driver-source.ts");
  try {
    assert.equal(loaded.module.SAND_UI_DRIVER_VERSION, 3);
    assert.match(loaded.module.SAND_UI_DRIVER_BOX_PATH, /driver-v3\.mjs/);
    assert.match(loaded.module.SAND_UI_DRIVER_SOURCE, /document\.title/);
    assert.match(loaded.module.SAND_UI_DRIVER_SOURCE, /Accessibility\.getFullAXTree/);
    assert.doesNotMatch(loaded.module.SAND_UI_DRIVER_SOURCE, /Page\.captureScreenshot/);
    assert.match(loaded.module.SAND_UI_DRIVER_SOURCE, /launch_browser is disabled/);
  } finally {
    await loaded.dispose();
  }
});
