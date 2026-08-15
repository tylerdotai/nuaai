import { CodexProvider } from './codex.js';
import { OllamaProvider } from './ollama.js';
import { DeterministicProvider } from './test.js';
import type { ProviderAdapter, ProviderHealth } from './types.js';

export interface ProviderRegistryConfig {
  root: string;
  providerName: string;
  model: string;
  baseUrl: string;
  embeddingModel: string;
  timeoutMs: number;
  ollamaEnabled?: boolean;
  codexEnabled?: boolean;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();

  constructor(config: ProviderRegistryConfig) {
    if (config.ollamaEnabled ?? true)
      this.providers.set(
        'ollama',
        new OllamaProvider(
          { baseUrl: config.baseUrl, model: config.model, embeddingModel: config.embeddingModel },
          config.timeoutMs,
        ),
      );
    if (config.codexEnabled ?? true)
      this.providers.set(
        'codex',
        new CodexProvider({
          model: config.model,
          workspaceRoot: config.root,
          timeoutMs: config.timeoutMs,
        }),
      );
    if (process.env.NUAAI_TEST_MODE === '1')
      this.providers.set('deterministic', new DeterministicProvider());
  }

  get(name: string): ProviderAdapter {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Unknown provider: ${name}`);
    return provider;
  }
  list(): string[] {
    return [...this.providers.keys()].sort();
  }
  async health(): Promise<ProviderHealth[]> {
    return Promise.all([...this.providers.values()].map((provider) => provider.health()));
  }
}
