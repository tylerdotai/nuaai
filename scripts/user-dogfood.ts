import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureRuntimeIdentity } from '../src/gateway/runtime.js';

const execFileAsync = promisify(execFile);
const baseUrl = 'http://127.0.0.1:45187';
const token = ensureRuntimeIdentity(process.cwd()).token;
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

type Run = {
  id: string;
  threadId: string;
  status: string;
  output: string;
  correlationId: string;
};

type EventRecord = {
  type: string;
  runId?: string;
  payload: Record<string, unknown>;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function waitForRun(runId: string, timeoutMs = 120_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await request<Run>(`/api/runs/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await request(`/api/runs/${runId}/cancel`, { method: 'POST' });
  throw new Error(`run ${runId} exceeded ${timeoutMs}ms and was cancelled`);
}

let eventCursor = 0;

async function eventsFor(runId: string): Promise<EventRecord[]> {
  const events: EventRecord[] = [];
  let after = eventCursor;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const result = await request<{ events: (EventRecord & { id?: number })[] }>(
      `/api/events?after=${after}`,
    );
    const lastId = result.events.at(-1)?.id;
    if (lastId) {
      if (lastId <= after) throw new Error('event pagination did not advance');
      after = lastId;
      eventCursor = lastId;
    }
    events.push(...result.events.filter((event) => event.runId === runId));
    if (result.events.length < 1000) return events;
  }
  throw new Error('event pagination exceeded the 100-page safety ceiling');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function createSession(title: string): Promise<{ threadId: string }> {
  const result = await request<{ thread: { id: string } }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  return { threadId: result.thread.id };
}

async function runCase(
  name: string,
  input: string,
  check: (run: Run, events: EventRecord[]) => void,
): Promise<Record<string, unknown>> {
  const { threadId } = await createSession(`User dogfood: ${name}`);
  const queued = await request<Run>('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ threadId, input }),
  });
  const run = await waitForRun(queued.id);
  const events = await eventsFor(run.id);
  check(run, events);
  const modelStarts = events.filter((event) => event.type === 'model.started');
  const toolStarts = events.filter((event) => event.type === 'tool.started');
  return {
    name,
    runId: run.id,
    status: run.status,
    modelTurns: modelStarts.length,
    tools: toolStarts.map((event) => event.payload.name),
    output: run.output.slice(0, 240),
  };
}

async function runCliCase(): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    'node',
    ['dist/cli.js', 'run', 'Say exactly READY. Do not use tools.'],
    {
      cwd: process.cwd(),
      maxBuffer: 100_000,
    },
  );
  const queued = JSON.parse(stdout) as Run;
  const run = await waitForRun(queued.id);
  const events = await eventsFor(run.id);
  assert(run.status === 'completed', `CLI no-tool request ended ${run.status}: ${run.output}`);
  assert(/ready/i.test(run.output), `CLI no-tool response did not contain READY: ${run.output}`);
  assert(
    events.some((event) => event.type === 'model.started'),
    `CLI run ${run.id} has no model.started evidence; status=${run.status}; output=${run.output}`,
  );
  assert(
    !events.some((event) => event.type === 'tool.started'),
    'CLI no-tool request executed a tool',
  );
  return {
    name: 'cli-no-tool',
    runId: run.id,
    status: run.status,
    tools: [],
    output: run.output.slice(0, 240),
  };
}

const health = await request<{ ok: boolean }>('/health', { headers: {} });
assert(health.ok, 'daemon health was not ok');
const providerCatalog = await request<{
  active: { name: string; model: string };
}>('/api/providers');

const results: Record<string, unknown>[] = [];
results.push(await runCliCase());
results.push(
  await runCase('ambiguous-no-tools', 'Stress test yourself. Do not use tools.', (run, events) => {
    assert(run.status === 'completed', `ambiguous request ended ${run.status}: ${run.output}`);
    const starts = events.filter((event) => event.type === 'model.started');
    assert(starts.length === 1, `ambiguous request used ${starts.length} model turns`);
    assert(Array.isArray(starts[0]?.payload.tools), 'model.started did not record tool schemas');
    assert((starts[0].payload.tools as unknown[]).length === 0, 'ambiguous request received tools');
    assert(
      !events.some((event) => event.type === 'tool.started'),
      'ambiguous request executed a tool',
    );
  }),
);
results.push(
  await runCase(
    'current-information',
    "What's the latest info on the UFC 330 fight tonight?",
    (run, events) => {
      assert(
        run.status === 'completed',
        `current-information request ended ${run.status}: ${run.output}`,
      );
      assert(run.output.trim().length > 0, 'current-information request returned empty output');
      assert(
        events.some(
          (event) => event.type === 'tool.started' && event.payload.name === 'web.search',
        ),
        'current-information request did not execute web.search',
      );
      assert(
        !events.some((event) => event.type === 'tool.failed'),
        'current-information request recorded a tool failure',
      );
    },
  ),
);
results.push(
  await runCase(
    'workspace-command',
    'Call workspace.command with pwd and report the absolute working directory.',
    (run, events) => {
      assert(run.status === 'completed', `workspace request ended ${run.status}: ${run.output}`);
      assert(
        events.some((event) => event.type === 'tool.completed'),
        'workspace request has no tool.completed',
      );
      assert(
        events.some(
          (event) => event.type === 'tool.started' && event.payload.name === 'workspace.command',
        ),
        'workspace request did not execute workspace.command',
      );
    },
  ),
);
results.push(
  await runCase(
    'provider-status',
    'Call provider.status and report the active provider and model exactly.',
    (run, events) => {
      assert(run.status === 'completed', `provider request ended ${run.status}: ${run.output}`);
      assert(
        run.output.toLowerCase().includes(providerCatalog.active.model.toLowerCase()),
        `provider result missing active model ${providerCatalog.active.model}: ${run.output}`,
      );
      assert(
        events.some(
          (event) => event.type === 'tool.started' && event.payload.name === 'provider.status',
        ),
        'provider request did not execute provider.status',
      );
      assert(
        !events.some((event) => event.type === 'tool.failed'),
        'provider request recorded a tool failure',
      );
    },
  ),
);

process.stdout.write(`${JSON.stringify({ ok: true, cases: results }, null, 2)}\n`);
