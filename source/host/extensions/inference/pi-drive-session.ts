import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

import { DEFAULT_OPENROUTER_COMPUTER_MODEL, type OpenRouterReasoningEffort } from "../../../shared/openrouter-models.js";
import { routedComputerResultParts, routedSpotlightWrappingEnabled, routedStallTimeoutMs } from "../../../shared/routed-computer-tools.js";
import { spotlightClose, spotlightOpen } from "../../../shared/sand-spotlight.js";
import { routedAbortErrorFromSignal } from "../../../shared/routed-turn-abort.js";

type Loose = Record<string, any>;
type ProviderMessage = { role: string; content: string | readonly unknown[] };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;

export const GROK_DRIVE_SYSTEM_PROMPT = [
  "You are Grok Bot, a warm, concise desktop assistant.",
  "You are running inside Grok Bot, not inside Codex CLI, Claude Code, or the Pi TUI.",
  "Your eyes are observe_ui, not screenshots. Call find_roots, then observe_ui on the Chrome page root.",
  "Quote only names, headings, and document.title that appear in that outline. Never invent products, search results, or headings.",
  "Act with act_ui({ stateId, actions: [{ action: \"press\", ref: \"@e12\" }] }) against the latest stateId. After act_ui, use the returned stateId.",
  "Do not call launch_browser — that would spawn a second Chrome the user cannot see. Chrome is the existing box window. Call box_chrome only when find_roots shows no page.",
  "Computer (pixel screenshot/click) is last resort for pictureOnly nodes only.",
  "Cookie banners, GDPR consent, and Accept/Accepteren/Akkoord buttons are yours: press them with act_ui. Never request_box_help for a cookie banner.",
  "The user watches your screen live next to this chat. Speak only when you are blocked or done.",
  "When a step needs the user (a login, 2FA, captcha, or payment), hand them the box with request_box_help immediately.",
  "Use plugin tools from this request when they are present. If none are supplied, do not claim Gmail or Composio is connected.",
].join("\n");

function parametersFromSchema(schema: unknown): TSchema {
  return schema != null && typeof schema === "object" ? Type.Unsafe(schema) : Type.Object({});
}

function toolName(definition: Loose): string {
  return typeof definition.name === "string" && definition.name.length > 0
    ? definition.name
    : typeof definition.toolName === "string" ? definition.toolName : "tool";
}

function toPiTools(definitions: readonly Loose[] | undefined, executeTool: RoutedToolExecutor | undefined): AgentTool[] {
  if (definitions == null || executeTool == null) return [];
  return definitions.map((definition) => {
    const name = toolName(definition);
    return {
      name,
      label: name,
      description: typeof definition.description === "string" ? definition.description : name,
      parameters: parametersFromSchema(definition.inputSchema),
      executionMode: "sequential" as const,
      execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
        if (signal?.aborted) {
          throw routedAbortErrorFromSignal(signal, () => new Error("The routed request timed out."));
        }
        const result = await executeTool(definition, params, toolCallId);
        const parts = routedComputerResultParts(result);
        if (parts.isError) throw new Error(parts.text);
        const wrappedText = routedSpotlightWrappingEnabled()
          ? `${spotlightOpen(name)}\n${parts.text}\n${spotlightClose()}`
          : parts.text;
        return {
          content: [
            { type: "text" as const, text: wrappedText },
            ...(parts.image == null ? [] : [{ type: "image" as const, data: parts.image.data, mimeType: parts.image.mimeType }]),
          ],
          details: {},
        };
      },
    };
  });
}

function toAgentMessages(messages: readonly ProviderMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const message of messages) {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    if (text.trim().length === 0) continue;
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
        api: "openai-completions",
        provider: "openrouter",
        model: DEFAULT_OPENROUTER_COMPUTER_MODEL,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      } as AgentMessage);
    } else {
      out.push({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
    }
  }
  return out;
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("");
  }
  return "";
}

function resolvePiOpenRouterModel(modelId: string) {
  try {
    const found = getBuiltinModel("openrouter", modelId as never);
    if (found != null) return found;
  } catch { /* unknown catalog id */ }
  const fallback = getBuiltinModel("openrouter", DEFAULT_OPENROUTER_COMPUTER_MODEL);
  return { ...fallback, id: modelId, name: modelId };
}

function piThinkingLevel(effort: OpenRouterReasoningEffort | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (effort == null || effort === "none") return "off";
  return effort;
}

export async function runPiDriveSession(options: {
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly Loose[] | undefined;
  readonly executeTool?: RoutedToolExecutor | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly maxSteps?: number | undefined;
  readonly modelId: string;
  readonly apiKey: string;
  readonly reasoningEffort?: OpenRouterReasoningEffort | undefined;
  readonly onTextDelta?: ((delta: string, accumulated: string) => void) | undefined;
  readonly onProgress?: ((line: string) => void) | undefined;
  readonly onStreamEvent?: ((event: { readonly type: string; readonly toolName?: string; readonly elapsedMs: number }) => void) | undefined;
  readonly systemExtra?: string | undefined;
  readonly stallTimeoutMs?: number | undefined;
}): Promise<string> {
  const abortSignal = options.abortSignal;
  if (abortSignal?.aborted) {
    throw routedAbortErrorFromSignal(abortSignal, () => new Error("The routed request timed out."));
  }
  const models = builtinModels();
  const model = models.getModel("openrouter", options.modelId) ?? resolvePiOpenRouterModel(options.modelId);
  const history = toAgentMessages(options.messages);
  const promptMessage = history.at(-1);
  const prior = history.slice(0, -1);
  const promptText = promptMessage?.role === "user"
    ? lastUserText(promptMessage)
    : "Continue.";
  let turns = 0;
  const started = Date.now();
  const roster = options.systemExtra?.trim() ?? "";
  const agent = new Agent({
    initialState: {
      systemPrompt: roster.length === 0 ? GROK_DRIVE_SYSTEM_PROMPT : `${GROK_DRIVE_SYSTEM_PROMPT}\n\n${roster}`,
      model,
      thinkingLevel: piThinkingLevel(options.reasoningEffort),
      tools: toPiTools(options.tools, options.executeTool),
      messages: prior,
    },
    streamFn: models.streamSimple.bind(models),
    getApiKey: async (provider) => provider === "openrouter" ? options.apiKey : undefined,
    toolExecution: "sequential",
    shouldStopAfterTurn: () => {
      turns += 1;
      return options.maxSteps != null && turns >= options.maxSteps;
    },
  });
  let visible = "";
  const stallTimeoutMs = options.stallTimeoutMs ?? routedStallTimeoutMs(true);
  let lastEventAt = Date.now();
  let stallFailure: Error | null = null;
  const touch = () => { lastEventAt = Date.now(); };
  const stallTimer = setInterval(() => {
    const silentFor = Date.now() - lastEventAt;
    if (silentFor > stallTimeoutMs) {
      stallFailure = new Error(`The drive session stalled for ${Math.round(silentFor / 100) / 10}s and was aborted.`);
      try { agent.abort(); } catch { /* already idle */ }
    }
  }, 250);
  agent.subscribe((event) => {
    touch();
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      visible += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, visible);
    }
    if (event.type === "tool_execution_start") {
      options.onProgress?.(`Using ${event.toolName}…`);
      options.onStreamEvent?.({ type: "tool-call", toolName: event.toolName, elapsedMs: Date.now() - started });
    }
    if (event.type === "turn_end") {
      options.onStreamEvent?.({ type: "step-finish", elapsedMs: Date.now() - started });
    }
  });
  const onAbort = () => {
    try { agent.abort(); } catch { /* already idle */ }
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt(promptText);
  } catch (error) {
    if (stallFailure != null) throw stallFailure;
    if (abortSignal?.aborted) throw routedAbortErrorFromSignal(abortSignal, () => new Error("The routed request timed out."));
    throw error;
  } finally {
    clearInterval(stallTimer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
  if (abortSignal?.aborted) {
    throw routedAbortErrorFromSignal(abortSignal, () => new Error("The routed request timed out."));
  }
  if (typeof agent.state.errorMessage === "string" && agent.state.errorMessage.length > 0) {
    throw new Error(agent.state.errorMessage);
  }
  return visible.trim().length > 0 ? visible : lastAssistantText(agent.state.messages);
}

function lastUserText(message: AgentMessage): string {
  if (!("content" in message) || !Array.isArray(message.content)) return "Continue.";
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("");
  return text.trim().length > 0 ? text : "Continue.";
}
