import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderRequest,
  ProviderStreamEvent,
} from './types.js';

export class DeterministicProvider implements ProviderAdapter {
  readonly name = 'deterministic';
  readonly model = 'local-test';
  private browserFailureAttempted = false;
  private longStreamAttempt = 0;
  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const input = request.messages.at(-1)?.content ?? '';
    const longStreamRequested = request.messages.some(
      (message) => message.role === 'user' && message.content === 'browser long stream smoke',
    );
    if (longStreamRequested) {
      this.longStreamAttempt += 1;
      if (this.longStreamAttempt === 1) {
        yield { type: 'delta', text: 'PROVISIONAL SHOULD DISAPPEAR' };
        yield {
          type: 'tool_call',
          id: 'long-stream-tool-1',
          name: 'workspace.list',
          arguments: {},
        };
        yield { type: 'done', text: '' };
        return;
      }
      const text = [
        '## Durable long response',
        '',
        'This completed report quotes “I’ll check…” and “Let me inspect…” as guardrail examples without making either promise.',
        '',
        ...Array.from(
          { length: 600 },
          (_, index) =>
            `- Evidence line ${index}: verified streaming content remains visible after reload.`,
        ),
        '',
        'FINAL_LONG_RESPONSE_SENTINEL',
      ].join('\n');
      for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: 'delta', text: line };
      }
      yield { type: 'done', text };
      return;
    }
    if (input === 'browser tool smoke') {
      yield { type: 'tool_call', id: 'browser-tool-1', name: 'workspace.list', arguments: {} };
      yield { type: 'done', text: '' };
      return;
    }
    if (input === 'browser write smoke') {
      yield {
        type: 'tool_call',
        id: 'browser-write-1',
        name: 'workspace.write',
        arguments: { path: 'work-sample-output.txt', content: 'agentic-write-ok' },
      };
      yield { type: 'done', text: '' };
      return;
    }
    if (input === 'browser markdown smoke') {
      const text =
        '## Verified output\n\n| Check | Result |\n| --- | --- |\n| Renderer | Passed |\n\n```ts\nconst answer = 42;\n```\n\n<script>alert("nope")</script>';
      yield { type: 'delta', text };
      yield { type: 'done', text };
      return;
    }
    if (input === 'browser failure smoke' && !this.browserFailureAttempted) {
      this.browserFailureAttempted = true;
      throw new Error('Deterministic browser failure');
    }
    if (input === 'browser cancel smoke') {
      for (let index = 0; index < 3_000; index += 1) {
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
