export const providerNames = ['anthropic', 'google', 'ollama', 'openai'] as const;
export type ProviderName = (typeof providerNames)[number];

export interface TextProvider {
  name: ProviderName;
  model: string;
  generateText(prompt: string): Promise<string>;
}

export type TextGenerator = (prompt: string) => Promise<string>;

export function isProviderName(value: string): value is ProviderName {
  return providerNames.includes(value as ProviderName);
}

export function createProvider(
  name: string,
  model: string,
  generateText: TextGenerator,
): TextProvider {
  if (!isProviderName(name)) {
    throw new Error(`Unsupported provider: ${name}`);
  }
  if (!model.trim()) {
    throw new Error('Provider model is required');
  }

  return { name, model, generateText };
}
