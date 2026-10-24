import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { attachmentAccept } from '../attachments.js';

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

export type ComposerAttachment = File & { id: string };

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
  attachments,
  onAttachmentsChange: setAttachments,
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
  attachments: ComposerAttachment[];
  onAttachmentsChange: (
    value: ComposerAttachment[] | ((current: ComposerAttachment[]) => ComposerAttachment[]),
  ) => void;
  onInput: (value: string) => void;
  onExpanded: (expanded: boolean) => void;
  onSubmit: (mode: 'next' | 'interrupt', files: File[]) => Promise<boolean> | undefined;
  onStop: () => void;
  onSwitchProvider: (provider: string, model: string) => void;
  onCommand: (command: ComposerCommand) => void;
}): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const [followupMode, setFollowupMode] = useState<'next' | 'interrupt'>('next');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const action = composerAction({
    input: input || (attachments.length ? 'Attached files' : ''),
    activeRunId,
  });
  const [isDragOver, setIsDragOver] = useState(false);
  const commandSuggestions = input.trim().startsWith('/')
    ? slashCommands.filter(({ command }) => command.startsWith(input.trim().toLowerCase()))
    : [];

  const addFiles = (files: FileList | File[]): void => {
    if (submitting || !selectedThread || connection !== 'connected') return;
    setAttachments((current) => [
      ...current,
      ...Array.from(files, (file) => Object.assign(file, { id: crypto.randomUUID() })),
    ]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files?.length) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    );
    if (imageItems.length) {
      e.preventDefault();
      const files = imageItems.flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
      addFiles(files);
    }
  };

  const capabilities = capabilitySummary(permissionProfile);
  const modelOptions = useMemo(() => {
    const options = providers.flatMap((provider) =>
      (provider.models ?? []).map((model) => ({
        value: `${provider.name}:${model}`,
        provider: provider.name,
        model,
        available: provider.available,
        detail: provider.detail,
      })),
    );
    if (activeProvider) {
      const activeValue = `${activeProvider.name}:${activeProvider.model}`;
      const activeHealth = providers.find((provider) => provider.name === activeProvider.name);
      if (!options.some((option) => option.value === activeValue))
        options.unshift({
          value: activeValue,
          provider: activeProvider.name,
          model: activeProvider.model,
          available: activeHealth?.available ?? true,
          detail: activeHealth?.detail ?? 'unknown',
        });
    }
    return options;
  }, [activeProvider, providers]);

  const getHealthTitle = (detail: string, available: boolean): string => {
    if (!available) return `Unavailable: ${detail}`;
    if (detail === 'ready') return 'Ready';
    return detail || 'Unknown';
  };

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

  const submit = async (): Promise<void> => {
    if (submitting) return;
    if (action === 'stop') {
      onStop();
      return;
    }
    if (action !== 'send' && action !== 'queue') return;
    setSubmitting(true);
    try {
      const submitted = attachments;
      if (await onSubmit(action === 'send' ? 'next' : followupMode, submitted))
        setAttachments((current) =>
          current.filter((file) => !submitted.some((sent) => sent.id === file.id)),
        );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={`composer ${expanded ? 'composer-expanded' : ''} ${isDragOver ? 'composer-drag-over' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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

      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="Attachments">
          {attachments.map((file) => (
            <span className="attachment-chip" key={file.id}>
              {file.name}
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                disabled={submitting}
                onClick={() => setAttachments((current) => current.filter((f) => f.id !== file.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={attachmentAccept}
        disabled={submitting}
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) {
            setAttachments((current) => [
              ...current,
              ...files.map((f) => Object.assign(f, { id: crypto.randomUUID() })),
            ]);
            event.target.value = '';
          }
        }}
      />

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
              if (input.trim() || attachments.length) void submit();
            }}
            onPaste={handlePaste}
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
          disabled={
            submitting || action === 'disabled' || !selectedThread || connection !== 'connected'
          }
          onClick={submit}
        >
          <span aria-hidden="true">{action === 'stop' ? '■' : '↑'}</span>
        </button>
      </div>

      {activeRunId && (input.trim() || attachments.length > 0) && (
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
          <div className="model-selector">
            {activeProvider &&
              (() => {
                const health = providers.find((p) => p.name === activeProvider.name);
                return (
                  <span
                    className={`health-dot ${health?.available ? 'available' : 'unavailable'}`}
                    title={getHealthTitle(health?.detail ?? '', health?.available ?? false)}
                    aria-label={getHealthTitle(health?.detail ?? '', health?.available ?? false)}
                  />
                );
              })()}
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
          </div>
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
          <button
            type="button"
            className="composer-attach"
            aria-label="Attach files"
            title="UTF-8 text/source files, PNG, JPEG, WebP · 4 files · 512 KiB total"
            disabled={submitting || connection !== 'connected' || !selectedThread}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
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
