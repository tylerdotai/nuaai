import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderRequest,
  ProviderStreamEvent,
} from './types.js';

export class DeterministicProvider implements ProviderAdapter {
  readonly name = 'deterministic';
  readonly model = 'local-test';
  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const input = request.messages.at(-1)?.content ?? '';
    if (input === 'browser tool smoke') {
      yield { type: 'tool_call', id: 'browser-tool-1', name: 'workspace.list', arguments: {} };
      yield { type: 'done', text: '' };
      return;
    }
    if (input === 'browser cancel smoke') {
      for (let index = 0; index < 100; index += 1) {
        if (request.signal?.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { type: 'delta', text: `cancel-${index} ` };
      }
      yield { type: 'done', text: 'cancel complete' };
      return;
    }
    const text = 'NUAAI deterministic test response';
    yield { type: 'delta', text };
    yield { type: 'done', text };
  }
  async embed(_text: string): Promise<number[]> {
    return Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
  }
  async health(): Promise<ProviderHealth> {
    return { name: this.name, available: true, detail: 'Test-only provider enabled' };
  }
}
