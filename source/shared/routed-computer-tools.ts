export const ROUTED_COMPUTER_PROVIDER_IDENTIFIER = "grok-bot-computer";
export const ROUTED_COMPUTER_TOOL_NAME = "Computer";
export const ROUTED_BOX_HELP_TOOL_NAME = "request_box_help";
export const ROUTED_BOX_CHROME_TOOL_NAME = "box_chrome";
export const ROUTED_COMPUTER_SCREENSHOT_MIME = "image/webp";

export const ROUTED_PLUGIN_MAX_STEPS = 8;
export const ROUTED_COMPUTER_MAX_STEPS = 32;
export const ROUTED_COMPUTER_SCREENSHOT_LOOP_LIMIT = 4;
export const ROUTED_INFERENCE_TURN_TIMEOUT_MS = 90_000;
export const ROUTED_COMPUTER_INFERENCE_TURN_TIMEOUT_MS = 300_000;

const COMPUTER_ACTION_ENUM = ["screenshot", "click", "move", "drag", "type", "key", "scroll", "wait"] as const;

function asNullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, { type: "null" }] };
}

function strictObject(
  properties: Record<string, unknown>,
  alwaysRequired: readonly string[] = [],
): { type: "object"; additionalProperties: false; properties: Record<string, unknown>; required: string[] } {
  const next: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(properties)) {
    next[key] = alwaysRequired.includes(key) ? schema : asNullable(schema as Record<string, unknown>);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: next,
    required: Object.keys(next),
  };
}

const coordinateItem = strictObject(
  { x: { type: "integer" }, y: { type: "integer" } },
  ["x", "y"],
);

const computerActionObject = strictObject({
  action: { type: "string", enum: [...COMPUTER_ACTION_ENUM] },
  x: { type: "integer" },
  y: { type: "integer" },
  x2: { type: "integer" },
  y2: { type: "integer" },
  path: { type: "array", items: coordinateItem },
  text: { type: "string" },
  key: { type: "string" },
  button: { type: "string", enum: ["left", "right", "middle"] },
  count: { type: "integer", minimum: 1, maximum: 3 },
  direction: { type: "string", enum: ["up", "down", "left", "right"] },
  amount: { type: "integer" },
  durationMs: { type: "integer", minimum: 0, maximum: 30_000 },
  description: { type: "string" },
}, ["action"]);

export const ROUTED_COMPUTER_INPUT_SCHEMA = {
  ...computerActionObject,
  properties: {
    ...computerActionObject.properties,
    then: asNullable({
      type: "array",
      minItems: 1,
      maxItems: 9,
      items: computerActionObject,
    }),
  },
  required: [...computerActionObject.required, "then"],
};

export const ROUTED_BOX_HELP_INPUT_SCHEMA = strictObject({
  instruction: {
    type: "string",
    minLength: 1,
    description: 'A short instruction shown over the box (e.g. "Sign in to your Google account"). Keep it to one line.',
  },
  reason: {
    type: "string",
    enum: ["auth", "captcha", "payment", "other"],
    description: 'Why the user is needed: "auth" for sign-in, "captcha", "payment", or "other".',
  },
  domain: {
    type: "string",
    description: "Destination site the user is trying to access (e.g. plus.nl).",
  },
  idp_domain: {
    type: "string",
    description: "When the browser is on an SSO/IdP page, that IdP host. Omit otherwise.",
  },
}, ["instruction"]);

export function openAiStrictSchemaGap(schema: unknown, path = "$"): string | null {
  const record = asRecord(schema);
  if (record == null) return null;
  const types = Array.isArray(record.type) ? record.type : record.type == null ? [] : [record.type];
  if (types.includes("object") || record.properties != null) {
    const properties = asRecord(record.properties);
    if (properties != null) {
      if (record.additionalProperties !== false) return `${path}: additionalProperties must be false`;
      const required = record.required;
      if (!Array.isArray(required)) return `${path}: required must be an array`;
      for (const key of Object.keys(properties)) {
        if (!required.includes(key)) return `${path}: required missing ${key}`;
        const nested = openAiStrictSchemaGap(properties[key], `${path}.${key}`);
        if (nested != null) return nested;
      }
    }
  }
  if (record.items != null) {
    const nested = openAiStrictSchemaGap(record.items, `${path}.items`);
    if (nested != null) return nested;
  }
  if (Array.isArray(record.anyOf)) {
    for (const [index, option] of record.anyOf.entries()) {
      const nested = openAiStrictSchemaGap(option, `${path}.anyOf[${index}]`);
      if (nested != null) return nested;
    }
  }
  return null;
}

export const ROUTED_COMPUTER_TOOL_DESCRIPTION = [
  "Drive this agent's box desktop — the live screen shown in the UI as this agent's screen.",
  "Actions: screenshot, click, move, drag, type, key, scroll, wait.",
  "Chrome starts with no visible window. Call box_chrome with the destination URL only when Chrome is not already on screen. Never reopen a site homepage — that wipes search, filters, and the basket. Once Chrome is visible, keep driving that window. Never claim a page is loaded, searched, or clicked unless the latest Computer screenshot shows that window.",
  "Work in a see-act-verify loop: screenshot (or read the screenshot returned after every Computer call), then act, then read the fresh screen.",
  "Use coordinates from the latest screenshot. Never click blind off a remembered layout.",
  "Once Chrome is visible, put known URLs in the address bar (key Ctrl+l, type the URL, key Return) rather than hunting through menus.",
  "Do not screenshot in a loop. After at most two screenshots, click, type, or navigate — or stop and tell the user what you see.",
  "Cookie banners, GDPR consent, and Accept / Accepteren / Akkoord buttons are yours: click them from the latest screenshot. If a click misses, Tab to the button then Return. After two misses, continue without the banner.",
  "The user is looking at this chat, not the box screen. Never ask them to click, dismiss, or type on the box unless you have already called request_box_help for login, 2FA, captcha, or payment.",
  "You cannot enter the user's password, 2FA, captcha, or payment confirmation. Hand those steps to the user with request_box_help immediately; do not keep driving Computer toward checkout.",
].join(" ");

export const ROUTED_BOX_CHROME_TOOL_DESCRIPTION = [
  "Open the visible box Chrome window on this agent's display — the live screen in the UI.",
  "Pass the destination URL when you know it so Chrome opens straight there; omit url for a blank window.",
  "The desktop starts with no browser window. Call this only when Chrome is not already visible.",
  "Do not pass a site origin (plus.nl, example.com) again after Chrome is open — that reloads the homepage and loses search and basket state. Type in the page or put a deep URL in the address bar instead.",
  "Confirm with a Computer screenshot. Never claim the site is on screen until that screenshot shows Chrome.",
].join(" ");

export const ROUTED_BOX_CHROME_INPUT_SCHEMA = strictObject({
  url: {
    type: "string",
    description: "http(s) URL to open. Omit for a blank Chrome window.",
  },
});

export const ROUTED_BOX_HELP_TOOL_DESCRIPTION = [
  "Hand the box desktop to the user for a step only they can do: a login, SSO, passkey, 2FA, captcha, or payment confirmation.",
  "Do not use this for cookie banners, GDPR consent, or ordinary site popups — click those with Computer.",
  "Pass one short instruction (no paragraph). The box is surfaced with a hand-back button.",
  "You never see their password or 2FA. After they hand the box back, take a Computer screenshot and continue.",
].join(" ");

export type RoutedToolDefinition = {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

export function listRoutedComputerToolDefinitions(): readonly RoutedToolDefinition[] {
  return [
    {
      name: ROUTED_COMPUTER_TOOL_NAME,
      providerIdentifier: ROUTED_COMPUTER_PROVIDER_IDENTIFIER,
      toolName: ROUTED_COMPUTER_TOOL_NAME,
      description: ROUTED_COMPUTER_TOOL_DESCRIPTION,
      inputSchema: ROUTED_COMPUTER_INPUT_SCHEMA,
    },
    {
      name: ROUTED_BOX_HELP_TOOL_NAME,
      providerIdentifier: ROUTED_COMPUTER_PROVIDER_IDENTIFIER,
      toolName: ROUTED_BOX_HELP_TOOL_NAME,
      description: ROUTED_BOX_HELP_TOOL_DESCRIPTION,
      inputSchema: ROUTED_BOX_HELP_INPUT_SCHEMA,
    },
    {
      name: ROUTED_BOX_CHROME_TOOL_NAME,
      providerIdentifier: ROUTED_COMPUTER_PROVIDER_IDENTIFIER,
      toolName: ROUTED_BOX_CHROME_TOOL_NAME,
      description: ROUTED_BOX_CHROME_TOOL_DESCRIPTION,
      inputSchema: ROUTED_BOX_CHROME_INPUT_SCHEMA,
    },
  ];
}

export function isRoutedComputerTool(definition: { readonly providerIdentifier?: unknown; readonly name?: unknown; readonly toolName?: unknown }): boolean {
  if (definition.providerIdentifier === ROUTED_COMPUTER_PROVIDER_IDENTIFIER) return true;
  const name = typeof definition.name === "string" ? definition.name : typeof definition.toolName === "string" ? definition.toolName : "";
  return name === ROUTED_COMPUTER_TOOL_NAME || name === ROUTED_BOX_HELP_TOOL_NAME || name === ROUTED_BOX_CHROME_TOOL_NAME;
}

export type RoutedComputerImage = { readonly data: string; readonly mimeType: string };

export type RoutedComputerResultParts = {
  readonly text: string;
  readonly image?: RoutedComputerImage;
  readonly isError: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function imageFromValue(value: unknown): RoutedComputerImage | undefined {
  const record = asRecord(value);
  const data = record?.data ?? record?.screenshot;
  const mimeType = typeof record?.mimeType === "string" && record.mimeType.length > 0
    ? record.mimeType
    : ROUTED_COMPUTER_SCREENSHOT_MIME;
  return typeof data === "string" && data.length > 0 ? { data, mimeType } : undefined;
}

function contentItems(value: unknown): readonly unknown[] {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const success = result?.case === "success" ? asRecord(result.value) : asRecord(root?.value) ?? root;
  return Array.isArray(success?.content) ? success.content : [];
}

export function routedComputerResultParts(value: unknown): RoutedComputerResultParts {
  if (typeof value === "string") return { text: value, isError: false };
  const root = asRecord(value);
  if (root == null) return { text: String(value), isError: false };
  const result = asRecord(root.result);
  if (result?.case === "error") {
    const detail = asRecord(result.value);
    return { text: typeof detail?.error === "string" ? detail.error : JSON.stringify(value), isError: true };
  }
  const texts: string[] = [];
  let image: RoutedComputerImage | undefined;
  for (const raw of contentItems(value)) {
    const item = asRecord(raw);
    const carrier = asRecord(item?.content);
    const payload = asRecord(carrier?.value);
    if (carrier?.case === "text" && typeof payload?.text === "string") texts.push(payload.text);
    else if (carrier?.case === "image") image ??= imageFromValue(payload);
    else if (typeof item?.type === "string" && item.type === "text" && typeof item.text === "string") texts.push(item.text);
    else if (typeof item?.type === "string" && item.type === "image") image ??= imageFromValue(item);
  }
  const success = result?.case === "success" ? asRecord(result.value) : root;
  image ??= imageFromValue(success);
  image ??= typeof success?.screenshot === "string" && success.screenshot.length > 0
    ? { data: success.screenshot, mimeType: ROUTED_COMPUTER_SCREENSHOT_MIME }
    : undefined;
  const text = texts.join("\n").trim()
    || (typeof success?.text === "string" ? success.text : "")
    || (image == null ? JSON.stringify(value) : "Computer action ran on the box desktop.");
  return { text, ...(image == null ? {} : { image }), isError: success?.isError === true };
}

export function routedComputerMcpResult(parts: {
  readonly text: string;
  readonly image?: RoutedComputerImage;
  readonly isError?: boolean;
  readonly handoff?: { readonly requestId: string; readonly instruction: string };
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [
    { content: { case: "text", value: { text: parts.text } } },
  ];
  if (parts.image != null) {
    content.push({
      content: {
        case: "image",
        value: { data: parts.image.data, mimeType: parts.image.mimeType },
      },
    });
  }
  return {
    result: {
      case: parts.isError === true ? "error" : "success",
      value: parts.isError === true
        ? { error: parts.text }
        : {
            content,
            isError: false,
            ...(parts.handoff == null ? {} : { handoff: parts.handoff }),
          },
    },
  };
}

export function routedToolResultModelContent(value: unknown): Array<Record<string, unknown>> {
  const parts = routedComputerResultParts(value);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: parts.text }];
  if (parts.image != null) {
    content.push({ type: "image", data: parts.image.data, mimeType: parts.image.mimeType });
  }
  return content;
}

export function openRouterToolResultContent(value: unknown): Array<Record<string, unknown>> {
  const parts = routedComputerResultParts(value);
  if (parts.image != null) return routedToolResultModelContent(value);
  if (parts.isError) return [{ type: "text", text: parts.text }];
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}

export function codexFunctionCallOutput(callId: string, value: unknown): Record<string, unknown> {
  const parts = routedComputerResultParts(value);
  if (parts.image == null) {
    return { type: "function_call_output", call_id: callId, output: JSON.stringify(value) };
  }
  return {
    type: "function_call_output",
    call_id: callId,
    output: [
      { type: "input_text", text: parts.text },
      { type: "input_image", image_url: `data:${parts.image.mimeType};base64,${parts.image.data}` },
    ],
  };
}

export function mergeRoutedToolLists(
  computer: readonly unknown[],
  plugins: readonly unknown[],
): unknown[] {
  return [...computer, ...plugins];
}

export function routedToolsIncludeComputer(tools: readonly unknown[] | undefined): boolean {
  return Array.isArray(tools) && tools.some(tool => isRoutedComputerTool(asRecord(tool) ?? {}));
}

export function routedComputerActionName(args: unknown): string | undefined {
  const action = asRecord(args)?.action;
  return typeof action === "string" && action.length > 0 ? action : undefined;
}

export function nextComputerScreenshotStreak(current: number, args: unknown): number {
  return routedComputerActionName(args) === "screenshot" ? current + 1 : 0;
}

export function computerScreenshotLoopMessage(): string {
  return "Stop taking screenshots without acting. Click, type, or navigate; call request_box_help for login or payment; or tell the user what you see and finish.";
}

const COOKIE_CONSENT_RE = /\b(cookie|cookies|consent|gdpr|cmp|onetrust|cookiebot|didomi|accepteren|akkoord|weigeren)\b/i;
const AUTH_OR_PAY_RE = /\b(login|log[\s-]?in|sign[\s-]?in|password|wachtwoord|2fa|mfa|otp|captcha|payment|checkout|betaal)\b/i;

export function isCookieConsentBoxHelp(instruction: string, reason?: string): boolean {
  const text = instruction.trim();
  if (text.length === 0) return false;
  if (reason === "auth" || reason === "captcha" || reason === "payment") return false;
  if (AUTH_OR_PAY_RE.test(text)) return false;
  return COOKIE_CONSENT_RE.test(text);
}

export function cookieConsentBoxHelpMessage(): string {
  return "Cookie banners and GDPR consent are yours. Click Accepteren/Accept with Computer from the latest screenshot. Do not request_box_help and do not ask the user — they cannot see the box screen from chat. If a click misses, Tab to the button then Return; after two misses continue without the banner.";
}

export function routedComputerBlockedByHandoffMessage(): string {
  return "The user has the box. Do not call Computer or request_box_help until they hand it back.";
}

export function routedBoxHelpHandoff(value: unknown): { readonly requestId: string; readonly instruction: string } | undefined {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  const success = result?.case === "success" ? asRecord(result.value) : null;
  const handoff = asRecord(success?.handoff);
  const requestId = typeof handoff?.requestId === "string" ? handoff.requestId : "";
  const instruction = typeof handoff?.instruction === "string" ? handoff.instruction : "";
  if (requestId.length === 0 || instruction.length === 0) return undefined;
  return { requestId, instruction };
}

export function routedBoxChromeAlreadyOpenMessage(): string {
  return "Chrome is already visible on this desktop. Do not reopen the site homepage — that wipes search and basket. Screenshot with Computer and continue from the current page.";
}

export function parseRoutedBrowserUrl(value: string): URL | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function isRoutedBrowserOriginHomeUrl(url: string): boolean {
  const parsed = parseRoutedBrowserUrl(url);
  if (parsed == null) return false;
  return (parsed.pathname === "/" || parsed.pathname === "") && parsed.search === "" && parsed.hash === "";
}

export function routedBoxChromeUrl(args: unknown): string | undefined {
  const record = asRecord(args);
  return typeof record?.url === "string" && record.url.trim().length > 0 ? record.url.trim() : undefined;
}

export function shouldSkipRoutedBoxChromeReload(url: string | undefined, chromeAlreadyOpen: boolean): boolean {
  if (!chromeAlreadyOpen) return false;
  if (url == null || url.length === 0) return true;
  return isRoutedBrowserOriginHomeUrl(url);
}

export function extractRoutedBrowserUrl(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const explicit = /https?:\/\/[^\s<>"'`]+/i.exec(trimmed);
  if (explicit != null) {
    try {
      const parsed = new URL(explicit[0].replace(/[),.;]+$/u, ""));
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
    } catch {}
  }
  const host = /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i.exec(trimmed);
  if (host == null) return undefined;
  const hostname = host[0].toLowerCase();
  if (hostname.includes("@")) return undefined;
  try {
    return new URL(`https://${hostname}`).href;
  } catch {
    return undefined;
  }
}

/**
 * The box runs one X display per agent window (window N = DISPLAY :N); the
 * exec daemon that runs this shell may sit on a different display than the
 * agent's screen, so the display must be pinned explicitly or Chrome opens
 * on a desktop neither the model nor the user ever sees.
 */
export function boxChromeDisplayPrefix(windowIndex?: number | null): string {
  return windowIndex != null && Number.isInteger(windowIndex) && windowIndex >= 1
    ? `DISPLAY=:${windowIndex} `
    : "";
}

export function buildBoxChromeCommand(url?: string | null, windowIndex?: number | null): string {
  const prefix = boxChromeDisplayPrefix(windowIndex);
  const launch = `${prefix}${boxChromeLaunchCommand(url)}`;
  // Block until the Chrome window is actually visible so the model's first
  // screenshot after this tool does not race a ~15s cold start.
  const wait = `${prefix}timeout 25 xdotool search --sync --onlyvisible --class box-chrome >/dev/null`;
  const visible = `${prefix}xdotool search --onlyvisible --class box-chrome >/dev/null`;
  // Re-launching a site origin (plus.nl/) while Chrome is already up reloads
  // the homepage and wipes search / basket. Deep URLs still navigate.
  if (url == null || url.trim().length === 0 || isRoutedBrowserOriginHomeUrl(url)) {
    return `{ ${visible} && exit 0; }; ${launch} && ${wait}`;
  }
  return `${launch} && ${wait}`;
}

function boxChromeLaunchCommand(url?: string | null): string {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return "box-chrome --new-window";
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "box-chrome --new-window";
    if (/['"\\$`]/.test(parsed.href)) return "box-chrome --new-window";
    return `box-chrome '${parsed.href}'`;
  } catch {
    return "box-chrome --new-window";
  }
}
