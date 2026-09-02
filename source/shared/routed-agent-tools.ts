export const ROUTED_SEND_TO_AGENT_TOOL_NAME = "SendToAgent";
export const ROUTED_CREATE_AGENT_TOOL_NAME = "CreateAgent";
export const ROUTED_UPDATE_AGENT_TOOL_NAME = "UpdateAgent";
export const ROUTED_AGENT_PROVIDER_IDENTIFIER = "grok-bot-agents";
export const ROUTED_AGENT_MESSAGE_MAX_TEXT_LENGTH = 8_000;
export const ROUTED_AGENT_NAME_MAX_LENGTH = 80;
export const ROUTED_AGENT_DESCRIPTION_MAX_LENGTH = 4_000;

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

export const ROUTED_CREATE_AGENT_TOOL_DESCRIPTION = [
  "Create a NEW agent for your user and get its agent id back immediately.",
  "Describe in `description` what the new agent is for and how it should behave — that brief becomes its personality.",
  "You may omit `name` to let the new agent choose its own name in its first turn; otherwise pass a short human-readable name.",
  "The new agent wakes right away, reads the brief, and introduces itself. Message it with SendToAgent when you need it.",
  "Use sparingly — prefer reusing an existing teammate from your teammates list.",
].join(" ");

export const ROUTED_CREATE_AGENT_INPUT_SCHEMA = strictObject(
  {
    description: {
      type: "string",
      minLength: 1,
      description: "What this agent is for and how it behaves. This is the brief the new agent reads first.",
    },
    name: {
      type: "string",
      minLength: 2,
      description: "Optional short human-readable name. Omit to let the new agent name itself.",
    },
  },
  ["description"],
);

export const ROUTED_UPDATE_AGENT_TOOL_DESCRIPTION = [
  "Update an agent's name and/or its persona instructions (description).",
  "Omit agent_id to update YOURSELF — pick your own name and describe how you behave.",
  "Pass another agent's id to update a teammate. Changes apply from that agent's next turn.",
].join(" ");

export const ROUTED_UPDATE_AGENT_INPUT_SCHEMA = strictObject(
  {
    agent_id: {
      type: "string",
      minLength: 1,
      description: "The id of the agent to update. Omit to update yourself.",
    },
    description: {
      type: "string",
      minLength: 1,
      description: "New persona/instructions text. Omit to leave the description unchanged.",
    },
    name: {
      type: "string",
      minLength: 2,
      description: "New short human-readable name. Omit to leave the name unchanged.",
    },
  },
);

export function listRoutedAgentManagementToolDefinitions(): readonly RoutedAgentToolDefinition[] {
  return [
    {
      name: ROUTED_CREATE_AGENT_TOOL_NAME,
      providerIdentifier: ROUTED_AGENT_PROVIDER_IDENTIFIER,
      toolName: ROUTED_CREATE_AGENT_TOOL_NAME,
      description: ROUTED_CREATE_AGENT_TOOL_DESCRIPTION,
      inputSchema: ROUTED_CREATE_AGENT_INPUT_SCHEMA,
    },
    {
      name: ROUTED_UPDATE_AGENT_TOOL_NAME,
      providerIdentifier: ROUTED_AGENT_PROVIDER_IDENTIFIER,
      toolName: ROUTED_UPDATE_AGENT_TOOL_NAME,
      description: ROUTED_UPDATE_AGENT_TOOL_DESCRIPTION,
      inputSchema: ROUTED_UPDATE_AGENT_INPUT_SCHEMA,
    },
  ];
}

export function isRoutedAgentManagementTool(definition: {
  readonly providerIdentifier?: unknown;
  readonly name?: unknown;
  readonly toolName?: unknown;
}): boolean {
  const name = typeof definition.name === "string"
    ? definition.name
    : typeof definition.toolName === "string" ? definition.toolName : "";
  if (definition.providerIdentifier !== ROUTED_AGENT_PROVIDER_IDENTIFIER) {
    return name === ROUTED_CREATE_AGENT_TOOL_NAME || name === ROUTED_UPDATE_AGENT_TOOL_NAME;
  }
  return name === ROUTED_CREATE_AGENT_TOOL_NAME || name === ROUTED_UPDATE_AGENT_TOOL_NAME;
}

export function isRoutedSendToAgentTool(definition: {
  readonly providerIdentifier?: unknown;
  readonly name?: unknown;
  readonly toolName?: unknown;
}): boolean {
  const name = typeof definition.name === "string"
    ? definition.name
    : typeof definition.toolName === "string" ? definition.toolName : "";
  if (name === ROUTED_CREATE_AGENT_TOOL_NAME || name === ROUTED_UPDATE_AGENT_TOOL_NAME) return false;
  if (definition.providerIdentifier === ROUTED_AGENT_PROVIDER_IDENTIFIER) {
    return name === ROUTED_SEND_TO_AGENT_TOOL_NAME;
  }
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
    if (row == null) continue;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (url.length === 0) continue;
    const alt = typeof row.alt === "string" && row.alt.trim().length > 0 ? row.alt.trim() : undefined;
    images.push({ url, ...(alt == null ? {} : { alt }) });
  }
  return images;
}

export function parseRoutedSendToAgentArgs(value: unknown): RoutedSendToAgentArgs | null {
  const row = asRecord(value);
  if (row == null) return null;
  const targetId = typeof row.target_id === "string" ? row.target_id.trim() : "";
  const message = typeof row.message === "string" ? clampAgentMessage(row.message) : "";
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

export type RoutedCreateAgentArgs = {
  readonly name?: string;
  readonly description: string;
};

export type RoutedUpdateAgentArgs = {
  readonly self: boolean;
  readonly agentId?: string;
  readonly name?: string;
  readonly description?: string;
};

function clampRoutedAgentField(text: string, max: number): string {
  return text.trim().slice(0, max);
}

export function parseRoutedCreateAgentArgs(value: unknown): RoutedCreateAgentArgs | null {
  const row = asRecord(value);
  if (row == null) return null;
  const description = clampRoutedAgentField(typeof row.description === "string" ? row.description : "", ROUTED_AGENT_DESCRIPTION_MAX_LENGTH);
  if (description.length === 0) return null;
  const name = clampRoutedAgentField(typeof row.name === "string" ? row.name : "", ROUTED_AGENT_NAME_MAX_LENGTH);
  return { ...(name.length === 0 ? {} : { name }), description };
}

export function parseRoutedUpdateAgentArgs(value: unknown): RoutedUpdateAgentArgs | null {
  const row = asRecord(value);
  if (row == null) return null;
  const agentId = typeof row.agent_id === "string" ? row.agent_id.trim() : "";
  const name = clampRoutedAgentField(typeof row.name === "string" ? row.name : "", ROUTED_AGENT_NAME_MAX_LENGTH);
  const description = clampRoutedAgentField(typeof row.description === "string" ? row.description : "", ROUTED_AGENT_DESCRIPTION_MAX_LENGTH);
  if (name.length === 0 && description.length === 0) return null;
  return {
    self: agentId.length === 0,
    ...(agentId.length === 0 ? {} : { agentId }),
    ...(name.length === 0 ? {} : { name }),
    ...(description.length === 0 ? {} : { description }),
  };
}

export function buildRoutedAgentIntroductionWakePrompt(brief: string): string {
  return [
    "You have just been created with this brief from your creator:",
    "",
    clampAgentMessage(brief).slice(0, 1_200),
    "",
    "In this first turn: 1) call UpdateAgent WITHOUT agent_id and set name — a short, human, memorable name for yourself; do not name yourself after your brief verbatim.",
    "2) call UpdateAgent WITHOUT agent_id and set description to 1-3 sentences describing your role and how you behave, based on the brief plus your own judgment.",
    "3) then send ONE short SendMessage telling the user who you are and what you'll handle.",
    "Keep everything concise. Do not use CreateAgent, SendToAgent, or any other tool this turn.",
  ].join("\n");
}

export function routedNewAgentIntroductionClause(selfName: string | undefined, selfDescription: string | undefined): string | null {
  const alreadyDescribed = typeof selfDescription === "string" && selfDescription.trim().length > 0;
  if (alreadyDescribed) return null;
  return [
    "You were just created, and this first message describes what the user wants you for.",
    `Your current name is "${selfName ?? "an unnamed bot"}".`,
    "Before answering: call UpdateAgent WITHOUT agent_id to (1) give yourself a short, fitting name and (2) write 1-3 sentence instructions for yourself based on the user's first message.",
    "Then answer the user normally, acknowledging the role you chose for yourself.",
  ].join(" ");
}

export function routedCreateAgentAck(name: string, id: string): string {
  return `Created agent "${name}" (id: ${id}). It is waking up with your brief and will introduce itself; message it with SendToAgent using that id when you need it.`;
}

export function routedCreateAgentNeedsBriefAck(): string {
  return "CreateAgent needs a description: write the brief for the new agent (what it is for and how it should behave). Pass name only if you want to fix its name yourself; omit it to let the new agent name itself.";
}

export function routedUpdateAgentAck(targetName: string): string {
  return `Updated ${targetName}. New name and instructions apply from their next turn.`;
}

export function routedUpdateAgentSelfAck(name: string | undefined): string {
  return name == null
    ? "Your instructions were updated. They apply from your next turn."
    : `You renamed yourself to "${name}" and updated your instructions. They apply from your next turn.`;
}

export function routedUpdateAgentNeedsFieldsAck(): string {
  return "UpdateAgent needs a name and/or a description to set. Omit agent_id to update yourself.";
}

export function routedAgentManagementFailedAck(detail: string): string {
  return `The agent profile change failed (${detail}). Try again shortly.`;
}
