import { buildSandBaseSystemPrompt } from "./system-prompt.js";
import { GROK_DRIVE_SYSTEM_PROMPT } from "../extensions/inference/pi-drive-session.js";
import { spotlightPromptSection } from "../../shared/sand-spotlight.js";

export interface RoutedSystemPromptOptions {
  readonly slot: "think" | "drive" | "summarize";
  readonly pluginTools: boolean;
  readonly toolNames: readonly string[];
  readonly extra?: string;
  readonly hasComputer?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export function routedUntrustedSectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAND_ROUTE_SPOTLIGHT !== "0";
}

function hasTool(toolNames: readonly string[], ...candidates: readonly string[]): boolean {
  const normalized = new Set(toolNames.map(name => name.trim().toLowerCase()).filter(Boolean));
  return candidates.some(candidate => normalized.has(candidate.toLowerCase()));
}

function removeSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return text;
  const after = text.slice(start + heading.length);
  const nextHeading = after.search(/\n## /);
  const end = nextHeading < 0 ? text.length : start + heading.length + nextHeading;
  return `${text.slice(0, start).trimEnd()}\n\n${text.slice(end).trimStart()}`.trim();
}

function adaptOfficialPromptForRoutedThink(base: string, toolNames: readonly string[]): string {
  let prompt = base;
  prompt = removeSection(prompt, "## SendMessage is your only voice");
  prompt = removeSection(prompt, "## Cursor Origin");
  if (!hasTool(toolNames, "CloudAgent")) {
    prompt = removeSection(prompt, "## Code changes");
  }
  if (!hasTool(toolNames, "Task", "SendToAgent")) {
    prompt = removeSection(prompt, "## Delegating background work");
  }
  if (!hasTool(toolNames, "GenerateImage")) {
    prompt = prompt.replace(
      /- When you've done something visible, attach the screenshot or file that proves it\./,
      "- When you've done something visible, describe what changed clearly in your reply.",
    );
  }
  return prompt;
}

function routedThinkDeliverySection(): string {
  return [
    "## How replies reach the user (OpenRouter coordinator)",
    "On this inference path there is no SendMessage tool. Your plain assistant text is delivered directly to the user in chat after tool calls finish.",
    "Reply first in natural language when someone is waiting on you, then use tools. Between tool steps, narration is discarded — put meaningful results in your final text reply.",
    "Do not claim you invoked SendMessage, attached screenshots in chat, or launched cloud agents unless those tools are attached to this turn.",
  ].join("\n");
}

function routedToolTruthSection(toolNames: readonly string[]): string {
  const listed = toolNames.length === 0
    ? "(none besides the model's built-in reasoning)"
    : toolNames.join(", ");
  return [
    "## Tools on this turn",
    `Only call tools attached to this request: ${listed}.`,
    "Do not invoke SendMessage, Shell, Read, Task, GenerateImage, CloudAgent, or Computer unless they appear in that list.",
  ].join("\n");
}

function routedReconstructionOverlay(options: RoutedSystemPromptOptions): string {
  const lines = [
    "## Grok Bot reconstruction (OpenRouter path)",
    "You are running inside Grok Bot, not inside Codex CLI, Claude Code, or the Pi TUI.",
    options.pluginTools
      ? "The tools supplied with this request include Grok Bot's already-connected plugins and accounts. Use plugins whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it."
      : "No Connect plugins are attached to this turn. Do not claim Gmail, Composio, or other plugins are connected, and do not say you searched or sent mail. If the user asks to use a plugin, tell them it is not available on this turn.",
  ];
  if (options.hasComputer === true) {
    lines.push(
      "You do have a screen you can drive: it is this agent's box desktop. Chrome starts with no visible window. Call box_chrome with the destination URL only if Chrome is not already visible, then use Computer or act_ui to observe and interact. Never claim a page is loaded, searched, or clicked unless the latest UI observation shows that window.",
      "The user watches your screen live next to this chat. You cannot attach or show screenshots in chat, so never say you are showing one; when asked to show something, put it on the screen and point them to your screen.",
      "Cookie banners, GDPR consent, and Accept/Accepteren/Akkoord buttons are yours: dismiss them on the box. Never request_box_help for a cookie banner.",
      "Do not announce screenshots, clicks, or waits. Speak only when you are blocked or done.",
      "Do not close the box browser or its windows. If a page looks blank, observe again after a short wait instead of quitting Chrome.",
      "When a step needs the user (a login, 2FA, captcha, or payment), hand them the box with request_box_help immediately.",
    );
  } else {
    lines.push(
      "Computer and box-driving tools are not attached on this turn. Do not claim you clicked, typed, or screenshot the box desktop unless a later turn attaches those tools.",
    );
  }
  lines.push(
    "Never ask for an API key for an already-connected plugin.",
    "Respond directly to the user in natural language after completing any necessary tool calls.",
  );
  return lines.join("\n");
}

export function buildRoutedSystemPrompt(options: RoutedSystemPromptOptions): string {
  const env = options.env ?? process.env;
  const untrusted = routedUntrustedSectionEnabled(env) ? spotlightPromptSection({ canSendMessage: false }) : null;
  if (options.slot === "drive") {
    const extra = options.extra?.trim() ?? "";
    const parts = [GROK_DRIVE_SYSTEM_PROMPT, routedReconstructionOverlay({ ...options, hasComputer: true })];
    if (untrusted != null) parts.push(untrusted);
    if (extra.length > 0) parts.push(extra);
    return parts.join("\n\n");
  }

  const adapted = adaptOfficialPromptForRoutedThink(
    buildSandBaseSystemPrompt({ cloudAgentsEnabled: false }),
    options.toolNames,
  );
  const parts = [
    adapted,
    routedThinkDeliverySection(),
    routedToolTruthSection(options.toolNames),
    routedReconstructionOverlay(options),
  ];
  if (untrusted != null) parts.push(untrusted);
  const extra = options.extra?.trim() ?? "";
  if (extra.length > 0) parts.push(extra);
  return parts.join("\n\n");
}

export function grokRouterSystemPrompt(
  pluginTools = false,
  extra?: string,
  promptOptions?: Pick<RoutedSystemPromptOptions, "slot" | "toolNames" | "hasComputer">,
): string {
  const toolNames = promptOptions?.toolNames ?? [];
  const slot = promptOptions?.slot ?? "think";
  const hasComputer = promptOptions?.hasComputer === true
    || (slot === "drive" && hasTool(toolNames, "Computer", "observe_ui", "act_ui", "box_chrome"));
  return buildRoutedSystemPrompt({
    slot,
    pluginTools,
    toolNames,
    hasComputer,
    ...(extra == null || extra.length === 0 ? {} : { extra }),
  });
}

export const GROK_ROUTER_SYSTEM_PROMPT = grokRouterSystemPrompt(true, undefined, {
  slot: "think",
  toolNames: [],
  hasComputer: false,
});
