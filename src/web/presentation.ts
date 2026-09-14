import type { EventRecord } from '../core/events.js';
import type { DatabaseStore, MessageArtifactRow, RunRow } from '../memory/db.js';
import type {
  ActivityGroup,
  ActivityItem,
  ArtifactView,
  MessageView,
  MessageViewStatus,
  ThreadPresentation,
} from './contracts.js';

const terminalRunEvents = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const internalArtifactKinds = new Set(['run_link', 'tool_calls', 'tool_result']);

function boundedText(value: unknown, maximum = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function messageStatus(status: string): MessageViewStatus {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed') return 'completed';
  return 'streaming';
}

function runLink(artifacts: MessageArtifactRow[]): string | undefined {
  const value = artifacts.find((artifact) => artifact.kind === 'run_link')?.payload.runId;
  return typeof value === 'string' && value ? value : undefined;
}

function targetFromPayload(payload: Record<string, unknown>): string | undefined {
  const argumentsValue = payload.arguments;
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue))
    return undefined;
  const argumentsRecord = argumentsValue as Record<string, unknown>;
  for (const key of ['path', 'query', 'command', 'url', 'pattern', 'file']) {
    if (argumentsRecord[key] !== undefined) return boundedText(argumentsRecord[key], 160);
  }
  return undefined;
}

function detailFromPayload(payload: Record<string, unknown>): string | undefined {
  const detail = payload.error ?? payload.result;
  if (detail === undefined) return undefined;
  return boundedText(detail, 240);
}

function activityForRun(run: RunRow, events: Array<EventRecord & { id: number }>): ActivityGroup[] {
  const tools = new Map<string, ActivityItem>();
  let startedAt = run.createdAt;
  let completedAt: number | undefined;
  let fallbackId = 0;

  for (const event of events) {
    if (event.type === 'run.started') startedAt = event.createdAt;
    if (event.type === 'tool.started') {
      const id = boundedText(event.payload.id ?? `event-${event.id}-${fallbackId++}`, 160);
      const previous = tools.get(id);
      tools.set(id, {
        id,
        name: boundedText(event.payload.name ?? previous?.name ?? 'Action', 160),
        status: previous?.status ?? 'running',
        ...(targetFromPayload(event.payload) ? { target: targetFromPayload(event.payload) } : {}),
        startedAt: previous?.startedAt ?? event.createdAt,
        ...(previous?.completedAt ? { completedAt: previous.completedAt } : {}),
        ...(previous?.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
        ...(previous?.detail ? { detail: previous.detail } : {}),
      });
      continue;
    }
    if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      const explicitId = event.payload.id;
      const name = boundedText(event.payload.name ?? 'Action', 160);
      const legacy = [...tools.values()].find(
        (tool) => tool.name === name && tool.status === 'running',
      );
      const id = boundedText(explicitId ?? legacy?.id ?? `event-${event.id}-${fallbackId++}`, 160);
      const previous = tools.get(id);
      const itemStartedAt = previous?.startedAt ?? event.createdAt;
      const detail = detailFromPayload(event.payload);
      tools.set(id, {
        id,
        name: boundedText(event.payload.name ?? previous?.name ?? 'Action', 160),
        status:
          event.type === 'tool.failed' || event.payload.isError === true ? 'failed' : 'completed',
        ...(previous?.target || targetFromPayload(event.payload)
          ? { target: previous?.target ?? targetFromPayload(event.payload) }
          : {}),
        ...(detail ? { detail } : {}),
        startedAt: itemStartedAt,
        completedAt: event.createdAt,
        durationMs: Math.max(0, event.createdAt - itemStartedAt),
      });
      continue;
    }
    if (terminalRunEvents.has(event.type)) completedAt = event.createdAt;
  }

  const status = messageStatus(run.status);
  if (status !== 'streaming') {
    for (const [id, tool] of tools) {
      if (tool.status !== 'running') continue;
      const end = completedAt ?? run.updatedAt;
      tools.set(id, {
        ...tool,
        status: status === 'completed' ? 'completed' : 'failed',
        completedAt: end,
        durationMs: Math.max(0, end - tool.startedAt),
      });
    }
  }

  if (!events.length && !tools.size) return [];
  return [
    {
      runId: run.id,
      status,
      startedAt,
      ...(completedAt ? { completedAt } : {}),
      items: [...tools.values()],
    },
  ];
}

function unsupportedArtifacts(artifacts: MessageArtifactRow[]): ArtifactView[] {
  return artifacts
    .filter((artifact) => !internalArtifactKinds.has(artifact.kind))
    .map((artifact) => ({
      type: 'unsupported',
      sourceKind: boundedText(artifact.kind, 80),
      label: 'Additional content is not supported in this NUAAI version.',
    }));
}

function failureForRun(
  run: RunRow,
  events: Array<EventRecord & { id: number }>,
): MessageView['error'] {
  if (run.status !== 'failed') return undefined;
  const failedEvent = [...events].reverse().find((event) => event.type === 'run.failed');
  return {
    message: boundedText(failedEvent?.payload.error ?? run.output ?? 'Run failed', 500),
    retryable: true,
  };
}

export function buildThreadPresentation(
  store: DatabaseStore,
  threadId: string,
  options: { before?: number; limit?: number } = {},
): ThreadPresentation {
  const page = store.listMessagePage(threadId, options.before, options.limit ?? 500);
  const messages = page.messages;
  const artifactsByMessage = new Map<string, MessageArtifactRow[]>();
  for (const artifact of store.listThreadArtifacts(threadId)) {
    const existing = artifactsByMessage.get(artifact.messageId) ?? [];
    existing.push(artifact);
    artifactsByMessage.set(artifact.messageId, existing);
  }
  const runCache = new Map<string, RunRow>();
  const eventCache = new Map<string, Array<EventRecord & { id: number }>>();
  const linkedRunIds = new Set<string>();
  const representedAssistantRuns = new Set<string>();

  const getRun = (runId: string): RunRow | undefined => {
    const cached = runCache.get(runId);
    if (cached) return cached;
    const run = store.getRun(runId);
    if (run) runCache.set(runId, run);
    return run;
  };
  const getEvents = (runId: string): Array<EventRecord & { id: number }> => {
    const cached = eventCache.get(runId);
    if (cached) return cached;
    const events = store.listRecentEventsForRun(runId, 250);
    eventCache.set(runId, events);
    return events;
  };

  const views: MessageView[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const artifacts = artifactsByMessage.get(message.id) ?? [];
    if (
      message.role === 'assistant' &&
      artifacts.some((artifact) => artifact.kind === 'tool_calls')
    )
      continue;
    const linkedRunId = runLink(artifacts);
    if (linkedRunId) linkedRunIds.add(linkedRunId);
    const run = linkedRunId ? getRun(linkedRunId) : undefined;
    if (message.role === 'assistant' && run) representedAssistantRuns.add(run.id);
    const events = run ? getEvents(run.id) : [];
    const status = message.role === 'assistant' && run ? messageStatus(run.status) : 'completed';
    views.push({
      id: message.role === 'assistant' && run ? `run:${run.id}:assistant` : message.id,
      ...(run ? { runId: run.id } : {}),
      role: message.role,
      markdown: message.content,
      createdAt: message.createdAt,
      ...(message.provider && message.model
        ? { provider: { name: message.provider, model: message.model } }
        : {}),
      status,
      activities: message.role === 'assistant' && run ? activityForRun(run, events) : [],
      ...(run ? { error: failureForRun(run, events) } : {}),
      citations: [],
      attachments: [],
      artifacts: unsupportedArtifacts(artifacts),
    });
  }

  const latestRun = store.getLatestRun(threadId);
  if (
    options.before === undefined &&
    latestRun &&
    linkedRunIds.has(latestRun.id) &&
    !representedAssistantRuns.has(latestRun.id)
  ) {
    const events = getEvents(latestRun.id);
    const markdown =
      latestRun.status === 'queued' || latestRun.status === 'running'
        ? events
            .filter((event) => event.type === 'model.delta')
            .map((event) => String(event.payload.text ?? ''))
            .join('')
        : latestRun.output;
    views.push({
      id: `run:${latestRun.id}:assistant`,
      runId: latestRun.id,
      role: 'assistant',
      markdown,
      createdAt: latestRun.updatedAt,
      provider: { name: latestRun.provider, model: latestRun.model },
      status: messageStatus(latestRun.status),
      activities: activityForRun(latestRun, events),
      ...(failureForRun(latestRun, events) ? { error: failureForRun(latestRun, events) } : {}),
      citations: [],
      attachments: [],
      artifacts: [],
    });
  }

  return {
    version: 1,
    threadId,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    messages: views,
  };
}
