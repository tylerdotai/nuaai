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
  persistSelection?: (provider: string, model: string) => Promise<void>;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();
  private activeProviderName: string;
  private activeModel: string;
  private readonly persistSelection?: ProviderRegistryConfig['persistSelection'];

  constructor(config: ProviderRegistryConfig) {
    this.activeProviderName = config.providerName;
    this.activeModel = config.model;
    this.persistSelection = config.persistSelection;
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

  active(): { name: string; model: string } {
    return { name: this.activeProviderName, model: this.activeModel };
  }

  async switch(providerName: string, model: string): Promise<{ name: string; model: string }> {
    const provider = this.get(providerName);
    const requestedModel = model.trim();
    if (!requestedModel) throw new Error('Model is required');
    const health = await provider.health();
    if (!health.available)
      throw new Error(`Provider ${providerName} is unavailable: ${health.detail}`);
    if (health.models?.length && !health.models.includes(requestedModel))
      throw new Error(`Model ${requestedModel} is not available from provider ${providerName}`);
    if (this.persistSelection) await this.persistSelection(providerName, requestedModel);
    this.activeProviderName = providerName;
    this.activeModel = requestedModel;
    return this.active();
  }

  async catalog(): Promise<{
    active: { name: string; model: string };
    providers: ProviderHealth[];
  }> {
    return { active: this.active(), providers: await this.health() };
  }
  async health(): Promise<ProviderHealth[]> {
    return Promise.all([...this.providers.values()].map((provider) => provider.health()));
  }
}
