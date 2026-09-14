import { CodexResponsesProvider } from './codex-responses.js';
import { OllamaProvider } from './ollama.js';
import { DeterministicProvider } from './test.js';
import type { ProviderAdapter, ProviderHealth } from './types.js';

export interface ProviderRegistryConfig {
  root: string;
  providerName: string;
  model: string;
  selectedModels?: Record<string, string>;
  baseUrl: string;
  embeddingModel: string;
  embeddingBaseUrl?: string;
  contextWindow?: number;
  codex?: {
    executable?: string;
    timeoutMs?: number;
  };
  timeoutMs: number;
  ollamaEnabled?: boolean;
  codexEnabled?: boolean;
  persistSelection?: (provider: string, model: string) => Promise<void>;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();
  private activeProviderName: string;
  private activeModel: string;
  private readonly selectedModels = new Map<string, string>();
  private readonly persistSelection?: ProviderRegistryConfig['persistSelection'];

  constructor(config: ProviderRegistryConfig) {
    for (const [provider, model] of Object.entries(config.selectedModels ?? {}))
      if (provider.trim() && model.trim()) this.selectedModels.set(provider, model);
    if (config.model.trim()) this.selectedModels.set(config.providerName, config.model);
    this.activeProviderName = config.providerName;
    this.activeModel = this.selectedModels.get(config.providerName) ?? config.model;
    this.persistSelection = config.persistSelection;
    if (config.ollamaEnabled ?? true)
      this.providers.set(
        'ollama',
        new OllamaProvider(
          {
            baseUrl: config.baseUrl,
            model:
              this.selectedModels.get('ollama') ??
              (config.providerName === 'ollama' ? config.model : 'qwen3.5:latest'),
            embeddingModel: config.embeddingModel,
            embeddingBaseUrl: config.embeddingBaseUrl,
          },
          config.timeoutMs,
          config.contextWindow ?? 262_144,
        ),
      );
    if (config.codexEnabled ?? true)
      this.providers.set(
        'codex',
        new CodexResponsesProvider({
          model:
            this.selectedModels.get('codex') ??
            (config.providerName === 'codex' ? config.model : ''),
          workspaceRoot: config.root,
          executable: config.codex?.executable,
          timeoutMs: config.codex?.timeoutMs,
        }),
      );
    if (process.env.NUAAI_TEST_MODE === '1')
      this.providers.set('deterministic', new DeterministicProvider());
  }

  async close(): Promise<void> {
    for (const provider of this.providers.values()) await provider.close?.();
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

  selection(providerName: string): { name: string; model: string } {
    const model = this.selectedModels.get(providerName) ?? this.providers.get(providerName)?.model;
    if (model === undefined) throw new Error(`Unknown provider: ${providerName}`);
    return { name: providerName, model };
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
    this.selectedModels.set(providerName, requestedModel);
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
