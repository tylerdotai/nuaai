import { type RefObject, useEffect, useMemo, useState } from 'react';

import {
  type ComposerCommand,
  capabilitySummary,
  composerAction,
  textareaHeight,
} from '../composer.js';
import type {
  ActiveProvider,
  ConnectionState,
  PermissionProfile,
  ProviderHealth,
} from '../contracts.js';

const slashCommands: Array<{ command: string; id: ComposerCommand; label: string }> = [
  { command: '/new', id: 'new-session', label: 'New conversation' },
  { command: '/refresh', id: 'refresh', label: 'Refresh runtime' },
  { command: '/memory', id: 'memory', label: 'Open memory' },
  { command: '/automate', id: 'automations', label: 'Open automations' },
  { command: '/system', id: 'system', label: 'Open system' },
];

export function AgentComposer({
  input,
  selectedThread,
  connection,
  activeRunId,
  activeProvider,
  providers,
  permissionProfile,
  queuedItems,
  expanded,
  textareaRef,
  onInput,
  onExpanded,
  onSubmit,
  onStop,
  onSwitchProvider,
  onCommand,
}: {
  input: string;
  selectedThread: boolean;
  connection: ConnectionState;
  activeRunId: string | null;
  activeProvider: ActiveProvider | null;
  providers: ProviderHealth[];
  permissionProfile: PermissionProfile;
  queuedItems: Array<{ id: string; prompt: string }>;
  expanded: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onInput: (value: string) => void;
  onExpanded: (expanded: boolean) => void;
  onSubmit: (mode: 'next' | 'interrupt') => void;
  onStop: () => void;
  onSwitchProvider: (provider: string, model: string) => void;
  onCommand: (command: ComposerCommand) => void;
}): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const [followupMode, setFollowupMode] = useState<'next' | 'interrupt'>('next');
  const action = composerAction({ input, activeRunId });
  const capabilities = capabilitySummary(permissionProfile);
  const modelOptions = useMemo(() => {
    const options = providers.flatMap((provider) =>
      (provider.models ?? []).map((model) => ({
        value: `${provider.name}:${model}`,
        provider: provider.name,
        model,
        available: provider.available,
      })),
    );
    if (activeProvider) {
      const activeValue = `${activeProvider.name}:${activeProvider.model}`;
      if (!options.some((option) => option.value === activeValue))
        options.unshift({
          value: activeValue,
          provider: activeProvider.name,
          model: activeProvider.model,
          available:
            providers.find((provider) => provider.name === activeProvider.name)?.available ?? true,
        });
    }
    return options;
  }, [activeProvider, providers]);
  const commandSuggestions = input.trim().startsWith('/')
    ? slashCommands.filter(({ command }) => command.startsWith(input.trim().toLowerCase()))
    : [];

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.dataset.empty = input ? 'false' : 'true';
    textarea.style.height = '0px';
    textarea.style.height = `${textareaHeight(textarea.scrollHeight, expanded)}px`;
  }, [expanded, input, textareaRef]);

  useEffect(() => {
    if (!activeRunId) setFollowupMode('next');
  }, [activeRunId]);

  const submit = (): void => {
    if (action === 'stop') {
      onStop();
      return;
    }
    if (action === 'send') onSubmit('next');
    else if (action === 'queue') onSubmit(followupMode);
  };

  return (
    <form
      className={`composer ${expanded ? 'composer-expanded' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {queuedItems.length > 0 && (
        <div className="composer-queue" aria-label="Queued follow-ups">
          {queuedItems.map((item) => (
            <div key={item.id}>
              <span>Queued follow-up</span>
              <p>{item.prompt}</p>
            </div>
          ))}
        </div>
      )}

      {commandSuggestions.length > 0 && (
        <div className="composer-commands" aria-label="Slash commands">
          {commandSuggestions.map((command) => (
            <button
              type="button"
              key={command.command}
              onClick={() => {
                onInput('');
                onCommand(command.id);
              }}
            >
              <code>{command.command}</code>
              <span>{command.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="composer-input-row">
        <label className="composer-field">
          <span className="sr-only">Message NUAAI</span>
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            placeholder={connection === 'connected' ? 'Message NUAAI…' : `${connection}…`}
            disabled={!selectedThread || connection !== 'connected'}
            onChange={(event) => onInput(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              if (input.trim()) submit();
            }}
          />
        </label>
        <button
          type="button"
          className="composer-action"
          data-action={action}
          aria-label={
            action === 'stop'
              ? 'Stop current run'
              : action === 'queue'
                ? followupMode === 'interrupt'
                  ? 'Interrupt and send'
                  : 'Send next'
                : 'Send message'
          }
          disabled={action === 'disabled' || !selectedThread || connection !== 'connected'}
          onClick={submit}
        >
          <span aria-hidden="true">{action === 'stop' ? '■' : '↑'}</span>
        </button>
      </div>

      {activeRunId && input.trim() && (
        <div className="composer-followup-modes" aria-label="Follow-up behavior">
          <button
            type="button"
            aria-pressed={followupMode === 'next'}
            onClick={() => setFollowupMode('next')}
          >
            Send next
          </button>
          <button
            type="button"
            aria-pressed={followupMode === 'interrupt'}
            onClick={() => setFollowupMode('interrupt')}
          >
            Interrupt and send
          </button>
        </div>
      )}

      <div className="composer-toolbar">
        <div className="composer-controls">
          <select
            aria-label="Model"
            value={activeProvider ? `${activeProvider.name}:${activeProvider.model}` : ''}
            disabled={!modelOptions.length}
            onChange={(event) => {
              const option = modelOptions.find(
                (candidate) => candidate.value === event.target.value,
              );
              if (option) onSwitchProvider(option.provider, option.model);
            }}
          >
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value} disabled={!option.available}>
                {option.provider} · {option.model}
              </option>
            ))}
          </select>
          <details className="composer-popover">
            <summary>{capabilities.label}</summary>
            <div>
              <strong>Available capabilities</strong>
              <ul>
                {capabilities.capabilities.map((capability) => (
                  <li key={capability}>{capability}</li>
                ))}
              </ul>
            </div>
          </details>
          <details className="composer-popover composer-context">
            <summary>Context</summary>
            <div>
              <strong>Thread history</strong>
              <p>Recent messages and the durable thread summary travel with each run.</p>
              <strong>Automatic memory</strong>
              <p>Semantic retrieval uses lexical fallback when embeddings are unavailable.</p>
            </div>
          </details>
        </div>
        <div className="composer-utilities">
          <span className={`composer-hint ${focused ? 'visible' : ''}`}>
            Enter to send · Shift+Enter for line break
          </span>
          <button
            type="button"
            className="composer-expand"
            aria-label={expanded ? 'Collapse composer' : 'Expand composer'}
            aria-pressed={expanded}
            onClick={() => onExpanded(!expanded)}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>
    </form>
  );
}
