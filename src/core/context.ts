import type { ProviderMessage, ProviderRequest } from '../providers/types.js';

const tokensPerUtf8Byte = 3;
const messageEnvelopeTokens = 6;

export interface ContextMessage extends ProviderMessage {
  id: string;
  pinned?: boolean;
}

export interface ContextSelectionOptions {
  maxTokens: number;
  currentMessageId: string;
  reservedTokens?: number;
}

export interface ContextSelection {
  messages: ContextMessage[];
  estimatedTokens: number;
  maxTokens: number;
  reservedTokens: number;
  selectedMessageCount: number;
  droppedMessageCount: number;
  droppedMessageIds: string[];
  overBudget: boolean;
}

interface MessageGroup {
  index: number;
  messages: ContextMessage[];
  tokens: number;
  required: boolean;
}

export function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / tokensPerUtf8Byte));
}

export function estimateMessageTokens(message: ProviderMessage): number {
  let tokens = messageEnvelopeTokens + estimateTokens(message.content);
  if (message.images?.length)
    tokens += message.images.reduce(
      (total, image) => total + 8 + estimateTokens(image.name ?? '') + estimateTokens(image.data),
      0,
    );
  if (message.toolCallId) tokens += estimateTokens(message.toolCallId);
  if (message.toolName) tokens += estimateTokens(message.toolName);
  for (const call of message.toolCalls ?? [])
    tokens +=
      8 +
      estimateTokens(call.id) +
      estimateTokens(call.name) +
      estimateTokens(JSON.stringify(call.arguments));
  return tokens;
}

export function estimateToolSchemaTokens(tools: unknown[]): number {
  return tools.length ? 12 + estimateTokens(JSON.stringify(tools)) : 0;
}

export class ContextBudgetError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED';
  constructor(
    readonly estimatedTokens: number,
    readonly maxTokens: number,
  ) {
    super(
      `Context budget exceeded before model transport (${estimatedTokens} > ${maxTokens}). Reduce the input or tool observations and retry.`,
    );
    this.name = 'ContextBudgetError';
  }
}

/** Check the actual canonical envelope, including attachments and finalization instructions.
 * Stop rather than silently discard observations that a later answer may rely on.
 */
export function estimateRequestContextTokens(
  request: Pick<ProviderRequest, 'systemPrompt' | 'messages' | 'tools' | 'dynamicTools'>,
  responseReserveTokens: number,
): number {
  const estimatedTokens =
    estimateMessageTokens({ role: 'system', content: request.systemPrompt ?? '' }) +
    estimateToolSchemaTokens([
      ...(request.tools ?? []),
      ...(request.dynamicTools ?? []).map(({ namespace, name, description, parameters }) => ({
        namespace,
        name,
        description,
        parameters,
      })),
    ]) +
    request.messages.reduce((total, message) => total + estimateMessageTokens(message), 0) +
    responseReserveTokens;
  return estimatedTokens;
}

export function assertRequestContextBudget(
  request: Pick<ProviderRequest, 'systemPrompt' | 'messages' | 'tools' | 'dynamicTools'>,
  maxTokens: number,
  responseReserveTokens: number,
): number {
  const estimatedTokens = estimateRequestContextTokens(request, responseReserveTokens);
  if (estimatedTokens > maxTokens) throw new ContextBudgetError(estimatedTokens, maxTokens);
  return estimatedTokens;
}

export function toolUnitBoundary(
  messages: ProviderMessage[],
  index: number,
): { end: number; complete: boolean } {
  const message = messages[index];
  if (message?.role !== 'assistant' || !message.toolCalls?.length)
    return { end: index + 1, complete: false };
  let end = index + 1;
  while (end < messages.length && messages[end].role === 'tool') end += 1;
  const rows = messages.slice(index + 1, end);
  const expected = new Set(message.toolCalls.map((call) => call.id));
  const actual = new Set(
    rows.map((row) => row.toolCallId).filter((id): id is string => typeof id === 'string'),
  );
  return {
    end,
    complete:
      expected.size === message.toolCalls.length &&
      rows.length === expected.size &&
      actual.size === expected.size &&
      [...expected].every((id) => actual.has(id)),
  };
}

function atomicUnits(messages: ContextMessage[]): {
  units: ContextMessage[][];
  invalidIds: string[];
} {
  const units: ContextMessage[][] = [];
  const invalidIds: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'tool') {
      invalidIds.push(message.id);
      continue;
    }
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      units.push([message]);
      continue;
    }

    const boundary = toolUnitBoundary(messages, index);
    const unit = messages.slice(index, boundary.end);
    if (boundary.complete) units.push(unit);
    else invalidIds.push(...unit.map((row) => row.id));
    index = boundary.end - 1;
  }
  return { units, invalidIds };
}

function conversationGroups(
  messages: ContextMessage[],
  currentMessageId: string,
): {
  groups: MessageGroup[];
  invalidIds: string[];
} {
  const { units, invalidIds } = atomicUnits(messages);
  const grouped: ContextMessage[][] = [];
  for (const unit of units) {
    const first = unit[0];
    if (first.role === 'system' || first.id === currentMessageId || first.role === 'user') {
      grouped.push([...unit]);
      continue;
    }
    const previous = grouped.at(-1);
    if (
      previous?.[0]?.role === 'user' &&
      !previous.some((message) => message.id === currentMessageId)
    )
      previous.push(...unit);
    else grouped.push([...unit]);
  }
  return {
    groups: grouped.map((group, index) => ({
      index,
      messages: group,
      tokens: group.reduce((total, message) => total + estimateMessageTokens(message), 0),
      required: group.some(
        (message) =>
          message.id === currentMessageId || message.role === 'system' || message.pinned === true,
      ),
    })),
    invalidIds,
  };
}

export function selectContextMessages(
  messages: ContextMessage[],
  options: ContextSelectionOptions,
): ContextSelection {
  const maxTokens = Math.max(0, Math.trunc(options.maxTokens));
  const reservedTokens = Math.max(0, Math.trunc(options.reservedTokens ?? 0));
  const { groups } = conversationGroups(messages, options.currentMessageId);
  const selected = new Set<number>();
  let estimatedTokens = reservedTokens;

  for (const group of groups) {
    if (!group.required) continue;
    selected.add(group.index);
    estimatedTokens += group.tokens;
  }

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (selected.has(group.index)) continue;
    if (estimatedTokens + group.tokens > maxTokens) break;
    selected.add(group.index);
    estimatedTokens += group.tokens;
  }

  const selectedMessages = groups
    .filter((group) => selected.has(group.index))
    .flatMap((group) => group.messages);
  const selectedIds = new Set(selectedMessages.map((message) => message.id));
  const droppedMessageIds = messages
    .filter((message) => !selectedIds.has(message.id))
    .map((message) => message.id);
  return {
    messages: selectedMessages,
    estimatedTokens,
    maxTokens,
    reservedTokens,
    selectedMessageCount: selectedMessages.length,
    droppedMessageCount: droppedMessageIds.length,
    droppedMessageIds,
    overBudget: estimatedTokens > maxTokens,
  };
}
