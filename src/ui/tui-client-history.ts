import type { TuiConversationMessage } from './tui-state.js';

/** Preserve chronological order while updating overlapping durable message IDs. */
export function mergeTuiMessages(
  older: TuiConversationMessage[],
  newer: TuiConversationMessage[],
): TuiConversationMessage[] {
  const merged = [...older];
  const positions = new Map(
    older.flatMap((message, index) => (message.id ? [[message.id, index] as const] : [])),
  );
  for (const message of newer) {
    const index = message.id ? positions.get(message.id) : undefined;
    if (index !== undefined) merged[index] = message;
    else {
      if (message.id) positions.set(message.id, merged.length);
      merged.push(message);
    }
  }
  return merged;
}
