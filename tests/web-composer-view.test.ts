import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentComposer } from '../src/web/components/AgentComposer.js';

const providers = [
  { name: 'codex', available: true, detail: 'ready', models: ['gpt-test', 'gpt-next'] },
  { name: 'ollama', available: true, detail: 'ready', models: ['nemotron'] },
];

function render(input: string, activeRunId: string | null, queuedPrompts: string[] = []): string {
  return renderToStaticMarkup(
    createElement(AgentComposer, {
      input,
      selectedThread: true,
      connection: 'connected',
      activeRunId,
      activeProvider: { name: 'codex', model: 'gpt-test' },
      providers,
      permissionProfile: 'operator',
      queuedItems: queuedPrompts.map((prompt, index) => ({ id: `run-${index}`, prompt })),
      expanded: false,
      textareaRef: createRef<HTMLTextAreaElement>(),
      onInput: vi.fn(),
      onExpanded: vi.fn(),
      onSubmit: vi.fn(),
      onStop: vi.fn(),
      onSwitchProvider: vi.fn(),
      onCommand: vi.fn(),
    }),
  );
}

describe('AgentComposer', () => {
  it('renders explicit queued follow-up modes and durable queue visibility', () => {
    const markup = render('check the tests next', 'run-active', ['review docs after this']);

    expect(markup).toContain('review docs after this');
    expect(markup).toContain('Queued follow-up');
    expect(markup).toContain('Send next');
    expect(markup).toContain('Interrupt and send');
    expect(markup).toContain('aria-label="Send next"');
  });

  it('shows real model, capability, and separate context controls without a fake attachment', () => {
    const markup = render('', null);

    expect(markup).toContain('gpt-test');
    expect(markup).toContain('nemotron');
    expect(markup).toContain('Operator');
    expect(markup).toContain('Run approved commands');
    expect(markup).toContain('Thread history');
    expect(markup).toContain('Automatic memory');
    expect(markup).not.toContain('Attach');
  });

  it('keeps the authoritative active model selectable when health omits a model catalog', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentComposer, {
        input: '',
        selectedThread: true,
        connection: 'connected',
        activeRunId: null,
        activeProvider: { name: 'deterministic', model: 'local-test' },
        providers: [{ name: 'deterministic', available: true, detail: 'ready' }],
        permissionProfile: 'operator',
        queuedItems: [],
        expanded: false,
        textareaRef: createRef<HTMLTextAreaElement>(),
        onInput: vi.fn(),
        onExpanded: vi.fn(),
        onSubmit: vi.fn(),
        onStop: vi.fn(),
        onSwitchProvider: vi.fn(),
        onCommand: vi.fn(),
      }),
    );

    expect(markup).toContain('local-test');
    expect(markup).not.toContain('<select disabled=""');
  });

  it('keeps Stop in the same primary action and offers supported slash commands', () => {
    expect(render('', 'run-active')).toContain('aria-label="Stop current run"');
    const commandMarkup = render('/n', null);
    expect(commandMarkup).toContain('/new');
    expect(commandMarkup).toContain('New conversation');
  });
});
