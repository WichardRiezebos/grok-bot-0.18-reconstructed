export const ROUTED_SEND_TO_AGENT_TOOL_NAME = "SendToAgent";
export const ROUTED_AGENT_PROVIDER_IDENTIFIER = "grok-bot-agents";
export const ROUTED_AGENT_MESSAGE_MAX_TEXT_LENGTH = 8_000;

export const ROUTED_SEND_TO_AGENT_TOOL_DESCRIPTION = [
  "Send a message to ANOTHER of your user's agents by its id (not the user).",
  "This is FIRE-AND-FORGET and asynchronous, like texting: it delivers your message, wakes that agent, and returns immediately with a delivery acknowledgement.",
  "It does NOT return their reply — any reply arrives later as its own message that wakes you on a fresh turn.",
  "Get agent ids from your teammates list in the system prompt — not a name.",
  "Pass priority=true to interrupt the recipient's current non-user turn.",
  "Group chats are not delivered on this path; message a teammate by their agent id instead.",
].join(" ");

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

const imageItem = strictObject(
  {
    url: { type: "string", minLength: 1, description: "file:// or https:// URL of the image." },
    alt: { type: "string", description: "Optional short description of this image." },
  },
  ["url"],
);

export const ROUTED_SEND_TO_AGENT_INPUT_SCHEMA = strictObject(
  {
    target_id: {
      type: "string",
      minLength: 1,
      description: "The id of the target agent from your teammates list — not a name.",
    },
    message: {
      type: "string",
      minLength: 1,
      description: "What to say. Write it as if texting a teammate: lead with the point, keep it short.",
    },
    images: {
      type: "array",
      items: imageItem,
      description: "Optional image(s) to send with the message. A 1:1 recipient actually sees them.",
    },
    priority: {
      type: "boolean",
      description: "When true, interrupt the recipient's current non-user work and wake them immediately.",
    },
  },
  ["target_id", "message"],
);

export type RoutedAgentToolDefinition = {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

export function listRoutedSendToAgentToolDefinitions(): readonly RoutedAgentToolDefinition[] {
  return [{
    name: ROUTED_SEND_TO_AGENT_TOOL_NAME,
    providerIdentifier: ROUTED_AGENT_PROVIDER_IDENTIFIER,
    toolName: ROUTED_SEND_TO_AGENT_TOOL_NAME,
    description: ROUTED_SEND_TO_AGENT_TOOL_DESCRIPTION,
    inputSchema: ROUTED_SEND_TO_AGENT_INPUT_SCHEMA,
  }];
}

export function isRoutedSendToAgentTool(definition: {
  readonly providerIdentifier?: unknown;
  readonly name?: unknown;
  readonly toolName?: unknown;
}): boolean {
  if (definition.providerIdentifier === ROUTED_AGENT_PROVIDER_IDENTIFIER) return true;
  const name = typeof definition.name === "string"
    ? definition.name
    : typeof definition.toolName === "string" ? definition.toolName : "";
  return name === ROUTED_SEND_TO_AGENT_TOOL_NAME;
}

export type RoutedAgentImage = { readonly url: string; readonly alt?: string };

export type RoutedSendToAgentArgs = {
  readonly targetId: string;
  readonly message: string;
  readonly images: readonly RoutedAgentImage[];
  readonly priority: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function clampAgentMessage(text: string): string {
  return text.trim().slice(0, ROUTED_AGENT_MESSAGE_MAX_TEXT_LENGTH);
}

function parseImages(value: unknown): RoutedAgentImage[] {
  if (!Array.isArray(value)) return [];
  const images: RoutedAgentImage[] = [];
  for (const raw of value) {
    const row = asRecord(raw);
    const url = typeof row?.url === "string" ? row.url.trim() : "";
    if (url.length === 0) continue;
    const alt = typeof row.alt === "string" && row.alt.trim().length > 0 ? row.alt.trim() : undefined;
    images.push({ url, ...(alt == null ? {} : { alt }) });
  }
  return images;
}

export function parseRoutedSendToAgentArgs(value: unknown): RoutedSendToAgentArgs | null {
  const row = asRecord(value);
  const targetId = typeof row?.target_id === "string" ? row.target_id.trim() : "";
  const message = typeof row?.message === "string" ? clampAgentMessage(row.message) : "";
  if (targetId.length === 0) return null;
  return {
    targetId,
    message,
    images: parseImages(row.images),
    priority: row.priority === true,
  };
}

export type RoutedRosterAgent = {
  readonly id: string;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly isGroup?: unknown;
  readonly remoteRoom?: unknown;
};

export function routedTeammatesOf(
  roster: readonly RoutedRosterAgent[],
  selfId: string,
): Array<{ readonly id: string; readonly name: string; readonly description?: string }> {
  const teammates: Array<{ readonly id: string; readonly name: string; readonly description?: string }> = [];
  for (const agent of roster) {
    if (agent.id === selfId || agent.isGroup === true || agent.remoteRoom != null) continue;
    const name = typeof agent.name === "string" && agent.name.trim().length > 0 ? agent.name.trim() : agent.id;
    const description = typeof agent.description === "string" && agent.description.trim().length > 0
      ? agent.description.trim()
      : undefined;
    teammates.push({ id: agent.id, name, ...(description == null ? {} : { description }) });
  }
  return teammates;
}

export function routedSendToAgentEmptyAck(): string {
  return "Message was empty; nothing was sent.";
}

export function routedSendToAgentSelfAck(): string {
  return "You can't message yourself with SendToAgent. Use SendMessage to talk to the user, or pick a different target id.";
}

export function routedSendToAgentMissingAck(targetId: string): string {
  return `No agent found with id ${targetId}.`;
}

export function routedSendToAgentGoneAck(): string {
  return "That agent no longer exists.";
}

export function routedSendToAgentGroupAck(): string {
  return "That is a group chat; group posts are not delivered from this path yet. Message a teammate by their agent id instead.";
}

export function routedSendToAgentSharedRoomAck(): string {
  return "That is a shared chat hosted by another user; agents can't message it directly.";
}

export function routedSendToAgentDeliveredAck(name: string, priority: boolean): string {
  return priority
    ? `Sent to ${name} as a priority message — it will interrupt their current non-user work and wake them now. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.`
    : `Sent to ${name}. This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now.`;
}
