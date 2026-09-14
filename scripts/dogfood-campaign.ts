import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

export interface DogfoodCase {
  id: string;
  category: string;
  title: string;
  prompt: string;
  expectedTools: string[];
  requiredOutputTerms: string[];
  minOutputChars: number;
}

export interface DogfoodActionEvidence {
  name: string;
  status: 'running' | 'completed' | 'failed';
}

export interface DogfoodEvidence {
  runId: string;
  status: string;
  output: string;
  startedAt: number;
  completedAt: number;
  terminalEvents: string[];
  actions: DogfoodActionEvidence[];
  modelAttempts: number;
  deltaEvents: number;
  firstDeltaAt?: number;
}

export interface DogfoodCaseResult {
  id: string;
  category: string;
  title: string;
  runId: string;
  status: string;
  passed: boolean;
  safetyViolation: boolean;
  failures: string[];
  durationMs: number;
  firstDeltaLatencyMs: number | null;
  outputChars: number;
  outputSha256: string;
  modelAttempts: number;
  deltaEvents: number;
  actions: DogfoodActionEvidence[];
}

export interface DogfoodCampaignScore {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  reliabilityGatePassed: boolean;
  globalSafetyViolations: string[];
  totalActions: number;
  completedActions: number;
}

const terminalEventTypes = new Set(['run.completed', 'run.failed', 'run.cancelled']);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function evaluateDogfoodCase(
  specification: DogfoodCase,
  evidence: DogfoodEvidence,
): DogfoodCaseResult {
  const failures: string[] = [];
  let safetyViolation = false;

  if (evidence.status !== 'completed') failures.push(`run status is ${evidence.status}`);
  if (evidence.terminalEvents.length !== 1) {
    failures.push(
      `expected exactly one terminal event, received ${String(evidence.terminalEvents.length)}`,
    );
    safetyViolation = true;
  }
  if (evidence.terminalEvents[0] !== 'run.completed') {
    failures.push(`terminal event is ${evidence.terminalEvents[0] ?? 'missing'}`);
  }
  for (const action of evidence.actions) {
    if (action.status === 'running') failures.push(`unfinished action: ${action.name}`);
    if (action.status === 'failed') {
      failures.push(`tool failed: ${action.name}`);
      safetyViolation = true;
    }
  }
  for (const expectedTool of specification.expectedTools) {
    if (
      !evidence.actions.some(
        (action) => action.name === expectedTool && action.status === 'completed',
      )
    )
      failures.push(`expected tool not completed: ${expectedTool}`);
  }
  if (evidence.output.length < specification.minOutputChars)
    failures.push(
      `durable output too short: ${String(evidence.output.length)} < ${String(specification.minOutputChars)}`,
    );
  const lowerOutput = evidence.output.toLocaleLowerCase('en-US');
  for (const term of specification.requiredOutputTerms) {
    if (!lowerOutput.includes(term.toLocaleLowerCase('en-US')))
      failures.push(`required output term missing: ${term}`);
  }
  if (/tool-turn limit was reached/i.test(evidence.output)) {
    failures.push('durable output contains a false tool-turn-limit failure');
    safetyViolation = true;
  }

  return {
    id: specification.id,
    category: specification.category,
    title: specification.title,
    runId: evidence.runId,
    status: evidence.status,
    passed: failures.length === 0,
    safetyViolation,
    failures,
    durationMs: Math.max(0, evidence.completedAt - evidence.startedAt),
    firstDeltaLatencyMs:
      evidence.firstDeltaAt === undefined
        ? null
        : Math.max(0, evidence.firstDeltaAt - evidence.startedAt),
    outputChars: evidence.output.length,
    outputSha256: sha256(evidence.output),
    modelAttempts: evidence.modelAttempts,
    deltaEvents: evidence.deltaEvents,
    actions: evidence.actions,
  };
}

export function scoreDogfoodCampaign(results: DogfoodCaseResult[]): DogfoodCampaignScore {
  const passed = results.filter((result) => result.passed).length;
  const globalSafetyViolations = results.flatMap((result) =>
    result.safetyViolation ? result.failures.map((failure) => `${result.id}: ${failure}`) : [],
  );
  const totalActions = results.reduce((sum, result) => sum + result.actions.length, 0);
  const completedActions = results.reduce(
    (sum, result) => sum + result.actions.filter((action) => action.status === 'completed').length,
    0,
  );
  const passRate = results.length === 0 ? 0 : passed / results.length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate,
    reliabilityGatePassed:
      results.length === 20 && passRate >= 0.9 && globalSafetyViolations.length === 0,
    globalSafetyViolations,
    totalActions,
    completedActions,
  };
}

interface EventRecord {
  type: string;
  payload: string;
  createdAt: number;
}

interface RunRecord {
  id: string;
  status: string;
  output: string;
  createdAt: number;
  updatedAt: number;
}

function parsePayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function collectDogfoodEvidence(
  database: Database.Database,
  runId: string,
): DogfoodEvidence {
  const run = database
    .prepare(
      'SELECT id, status, output, created_at AS createdAt, updated_at AS updatedAt FROM runs WHERE id = ?',
    )
    .get(runId) as RunRecord | undefined;
  if (!run) throw new Error(`Unknown dogfood run: ${runId}`);
  const events = database
    .prepare(
      'SELECT type, payload, created_at AS createdAt FROM events WHERE run_id = ? ORDER BY id',
    )
    .all(runId) as EventRecord[];
  const actions = new Map<string, DogfoodActionEvidence>();
  let fallbackAction = 0;
  for (const event of events) {
    if (!event.type.startsWith('tool.')) continue;
    const payload = parsePayload(event.payload);
    const name = typeof payload.name === 'string' ? payload.name : 'unknown';
    const id = typeof payload.id === 'string' ? payload.id : '';
    let key = id;
    if (!key) {
      const existing = [...actions.entries()].find(
        ([, action]) => action.name === name && action.status === 'running',
      );
      fallbackAction += 1;
      key = existing?.[0] ?? `${name}:${String(fallbackAction)}`;
    }
    if (event.type === 'tool.started') actions.set(key, { name, status: 'running' });
    if (event.type === 'tool.completed') actions.set(key, { name, status: 'completed' });
    if (event.type === 'tool.failed') actions.set(key, { name, status: 'failed' });
  }
  const startedAt =
    events.find((event) => event.type === 'run.started')?.createdAt ?? run.createdAt;
  const terminalEvents = events
    .filter((event) => terminalEventTypes.has(event.type))
    .map((event) => event.type);
  const completedAt =
    [...events].reverse().find((event) => terminalEventTypes.has(event.type))?.createdAt ??
    run.updatedAt;
  return {
    runId,
    status: run.status,
    output: run.output,
    startedAt,
    completedAt,
    terminalEvents,
    actions: [...actions.values()],
    modelAttempts: events.filter((event) => event.type === 'model.started').length,
    deltaEvents: events.filter((event) => event.type === 'model.delta').length,
    firstDeltaAt: events.find((event) => event.type === 'model.delta')?.createdAt,
  };
}

function renderMarkdown(
  generatedAt: string,
  score: DogfoodCampaignScore,
  results: DogfoodCaseResult[],
): string {
  const lines = [
    '# NUAAI v1.0.1 Production Dogfood Report',
    '',
    `Generated: ${generatedAt}`,
    '',
    '## Result',
    '',
    `- Gate: **${score.reliabilityGatePassed ? 'PASS' : 'BLOCK'}**`,
    `- Cases: ${String(score.passed)}/${String(score.total)} passed (${(score.passRate * 100).toFixed(1)}%)`,
    `- Actions: ${String(score.completedActions)}/${String(score.totalActions)} completed`,
    `- Global safety violations: ${String(score.globalSafetyViolations.length)}`,
    '',
    '## Cases',
    '',
  ];
  for (const result of results) {
    lines.push(
      `### ${result.id} — ${result.title}`,
      '',
      `- Result: **${result.passed ? 'PASS' : 'FAIL'}**`,
      `- Run: \`${result.runId}\``,
      `- Status: ${result.status}`,
      `- Duration: ${String(result.durationMs)} ms`,
      `- First delta: ${result.firstDeltaLatencyMs === null ? 'not observed' : `${String(result.firstDeltaLatencyMs)} ms`}`,
      `- Durable output: ${String(result.outputChars)} chars; SHA-256 \`${result.outputSha256}\``,
      `- Model attempts / delta events: ${String(result.modelAttempts)} / ${String(result.deltaEvents)}`,
      `- Actions: ${result.actions.length === 0 ? 'none' : result.actions.map((action) => `${action.name} (${action.status})`).join(', ')}`,
      `- Failures: ${result.failures.length === 0 ? 'none' : result.failures.join('; ')}`,
      '',
    );
  }
  if (score.globalSafetyViolations.length > 0) {
    lines.push(
      '## Safety Violations',
      '',
      ...score.globalSafetyViolations.map((item) => `- ${item}`),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const [databasePath, manifestPath, runMapPath, outputDirectory] = process.argv.slice(2);
  if (!databasePath || !manifestPath || !runMapPath || !outputDirectory)
    throw new Error(
      'Usage: tsx scripts/dogfood-campaign.ts <database> <manifest.json> <run-map.json> <output-dir>',
    );
  const specifications = JSON.parse(await readFile(manifestPath, 'utf8')) as DogfoodCase[];
  if (specifications.length !== 20)
    throw new Error(
      `Dogfood manifest must contain exactly 20 cases, received ${String(specifications.length)}`,
    );
  const runMap = JSON.parse(await readFile(runMapPath, 'utf8')) as Record<string, string>;
  const database = new Database(databasePath, { readonly: true });
  const results = specifications.map((specification) => {
    const runId = runMap[specification.id];
    if (!runId) throw new Error(`Missing run id for ${specification.id}`);
    return evaluateDogfoodCase(specification, collectDogfoodEvidence(database, runId));
  });
  database.close();
  const generatedAt = new Date().toISOString();
  const score = scoreDogfoodCampaign(results);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    `${outputDirectory}/v1.0.1-results.json`,
    `${JSON.stringify({ generatedAt, score, results }, null, 2)}\n`,
  );
  await writeFile(
    `${outputDirectory}/v1.0.1-report.md`,
    renderMarkdown(generatedAt, score, results),
  );
  process.stdout.write(`${JSON.stringify(score)}\n`);
  if (!score.reliabilityGatePassed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
