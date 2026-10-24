import { describe, expect, it } from 'vitest';
import { resultHash } from '../src/core/approvals.js';
import { type ActiveContextCheckpoint, ContextBufferManager } from '../src/core/context-buffer.js';
import { ContextBudgetError, estimateRequestContextTokens } from '../src/core/context.js';
import type { ProviderMessage } from '../src/providers/types.js';

function toolUnit(id: string): ProviderMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'workspace.read', arguments: { path: `${id}.txt` } }],
    },
    {
      role: 'tool',
      toolCallId: id,
      toolName: 'workspace.read',
      content: `Evidence ${id}: ${'🙂'.repeat(800)}`,
    },
  ];
}

function buffer(maxTokens: number, maxSummaryTokens = 400, goalMessage?: ProviderMessage) {
  const checkpoints: ActiveContextCheckpoint[] = [];
  const manager = new ContextBufferManager({
    maxTokens,
    responseReserveTokens: 0,
    maxSummaryTokens,
    goalMessage,
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  return { manager, checkpoints };
}

describe('active tool context buffer', () => {
  it('preserves the last complete observation above the compaction target when it still fits the hard limit', () => {
    const messages = toolUnit('last');
    const estimated = estimateRequestContextTokens({ messages }, 0);
    const { manager, checkpoints } = buffer(estimated);
    expect(manager.prepare({ messages })).toBe(messages);
    expect(checkpoints).toEqual([]);
  });

  it('does not invent a checkpoint for non-tool context and rejects an unshrinkable over-budget request', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Keep this exact goal.' }];
    const estimated = estimateRequestContextTokens({ messages }, 0);
    const { manager, checkpoints } = buffer(estimated);
    expect(manager.prepare({ messages })).toBe(messages);
    expect(() =>
      manager.prepare({ messages, systemPrompt: 'Oversized policy '.repeat(100) }),
    ).toThrow(ContextBudgetError);
    expect(messages).toEqual([{ role: 'user', content: 'Keep this exact goal.' }]);
    expect(checkpoints).toEqual([]);
  });

  it.each([false, true])(
    'archives atomic observations with provenance when goal is absent=%s',
    (absent) => {
      const goal: ProviderMessage = { role: 'user', content: 'Read both files; do not send mail.' };
      const first = toolUnit('first');
      const second = toolUnit('second');
      const messages = [...(absent ? [] : [goal]), ...first, ...second];
      const before = structuredClone(messages);
      const { manager, checkpoints } = buffer(1800, 700, absent ? undefined : goal);
      const prepared = manager.prepare({ messages });
      expect(messages).toEqual(before);
      expect(prepared.slice(absent ? 1 : 2)).toEqual(second);
      if (!absent) expect(prepared[0]).toBe(goal);
      expect(checkpoints).toHaveLength(1);
      const checkpoint = checkpoints[0];
      expect(checkpoint).toMatchObject({
        version: 1,
        archivedCallCount: 1,
        newlyArchivedCallIds: ['first'],
        sourceSha256: resultHash({ previous: '', unit: first }),
        recent: [
          {
            callId: 'first',
            tool: 'workspace.read',
            argumentsExcerpt: JSON.stringify({ path: 'first.txt' }),
            observationExcerpt: Array.from(first[1].content).slice(0, 240).join(''),
            observationSha256: resultHash(first[1].content),
          },
        ],
      });
      expect(prepared[absent ? 0 : 1].content).toBe(checkpoint.summary);
      expect(checkpoint.summary).toContain('not a claim of task completion');
      expect(checkpoint.summary).not.toContain('�');
      expect(estimateRequestContextTokens({ messages: prepared }, 0)).toBeLessThanOrEqual(1800);
    },
  );

  it('fails closed when the summary cannot retain provenance and leaves checkpoint state uncommitted', () => {
    const { manager, checkpoints } = buffer(1800, 1);
    const messages = [...toolUnit('first'), ...toolUnit('second')];
    const before = structuredClone(messages);
    expect(() => manager.prepare({ messages })).toThrow(
      'Checkpoint budget cannot preserve execution provenance',
    );
    expect(messages).toEqual(before);
    expect(checkpoints).toEqual([]);
    const fitting = toolUnit('small');
    expect(manager.prepare({ messages: fitting })).toBe(fitting);
    expect(checkpoints).toEqual([]);
  });
});
