import type { ProviderMessage } from './types.js';

export interface CanonicalProviderMessages {
  systemPrompt?: string;
  messages: ProviderMessage[];
}

export function canonicalProviderMessages(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
): CanonicalProviderMessages {
  const systemParts: string[] = [];
  const seen = new Set<string>();
  for (const content of [
    systemPrompt,
    ...messages.filter((message) => message.role === 'system').map((message) => message.content),
  ]) {
    if (!content?.trim()) continue;
    const key = content.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    systemParts.push(content);
  }
  const canonicalSystemPrompt = systemParts.join('\n\n');
  return {
    ...(canonicalSystemPrompt ? { systemPrompt: canonicalSystemPrompt } : {}),
    messages: messages.filter((message) => message.role !== 'system'),
  };
}
