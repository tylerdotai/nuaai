import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approvalPayloadHash,
  canonicalizeApprovalArguments,
  publicApprovalRequest,
} from '../src/core/approvals.js';
import { createEvent } from '../src/core/events.js';
import { DatabaseStore, openAppDatabase } from '../src/memory/db.js';

const stores: DatabaseStore[] = [];

async function store(): Promise<{ root: string; value: DatabaseStore }> {
  const root = await mkdtemp(join(tmpdir(), 'nuaai-approval-store-'));
  const value = new DatabaseStore(openAppDatabase(root));
  stores.push(value);
  return { root, value };
}

function input(id = 'approval-1', expiresAt = 2_000) {
  const canonicalArguments = canonicalizeApprovalArguments({ path: 'notes.txt', content: 'safe' });
  return {
    id,
    runId: 'run-1',
    threadId: 'thread-1',
    sessionId: 'session-1',
    toolCallId: `call-${id}`,
    toolName: 'workspace.write',
    canonicalArguments,
    payloadHash: approvalPayloadHash('run-1', 'workspace.write', canonicalArguments),
    requiredPermission: 'write' as const,
    permissionSource: 'web',
    risk: 'medium · workspace',
    target: 'notes.txt',
    providerOwned: false,
    expiresAt,
  };
}

afterEach(() => {
  for (const value of stores.splice(0)) value.close();
});

describe('approval persistence state machine', () => {
  it('canonicalizes deterministically and binds hashes to the run, tool, and exact payload', () => {
    const left = canonicalizeApprovalArguments({ z: 1, nested: { b: true, a: ['x', 2] } });
    const right = canonicalizeApprovalArguments({ nested: { a: ['x', 2], b: true }, z: 1 });
    expect(left).toBe(right);
    expect(approvalPayloadHash('run-a', 'tool.a', left)).toBe(
      approvalPayloadHash('run-a', 'tool.a', right),
    );
    expect(approvalPayloadHash('run-b', 'tool.a', left)).not.toBe(
      approvalPayloadHash('run-a', 'tool.a', left),
    );
    expect(approvalPayloadHash('run-a', 'tool.b', left)).not.toBe(
      approvalPayloadHash('run-a', 'tool.a', left),
    );
    expect(
      approvalPayloadHash('run-a', 'tool.a', canonicalizeApprovalArguments({ z: 2 })),
    ).not.toBe(approvalPayloadHash('run-a', 'tool.a', left));
  });

  it('allows one exact execution and rejects payload mismatch and replay', async () => {
    const { value } = await store();
    value.createApprovalRequest(input(), 1_000);
    value.decideApprovalRequest('approval-1', 'approved', 1_100);
    expect(() =>
      value.claimApprovalExecution(
        'approval-1',
        {
          runId: 'run-1',
          toolName: 'workspace.write',
          canonicalArguments: canonicalizeApprovalArguments({ path: 'other.txt', content: 'safe' }),
        },
        1_200,
      ),
    ).toThrow('payload');
    expect(
      value.claimApprovalExecution(
        'approval-1',
        {
          runId: 'run-1',
          toolName: 'workspace.write',
          canonicalArguments: input().canonicalArguments,
        },
        1_200,
      ).status,
    ).toBe('executed');
    expect(() =>
      value.claimApprovalExecution(
        'approval-1',
        {
          runId: 'run-1',
          toolName: 'workspace.write',
          canonicalArguments: input().canonicalArguments,
        },
        1_300,
      ),
    ).toThrow('already consumed');
  });

  it('returns missing requests and rejects decisions or claims after terminal state', async () => {
    const { value } = await store();
    expect(value.getApprovalRequest('missing')).toBeUndefined();

    const { sessionId: _sessionId, ...withoutSession } = input('without-session');
    expect(value.createApprovalRequest(withoutSession, 1_000).sessionId).toBeNull();

    value.createApprovalRequest(input('denied-claim'), 1_000);
    value.decideApprovalRequest('denied-claim', 'denied', 1_100);
    expect(() =>
      value.claimApprovalExecution(
        'denied-claim',
        {
          runId: 'run-1',
          toolName: 'workspace.write',
          canonicalArguments: input().canonicalArguments,
        },
        1_200,
      ),
    ).toThrow('is not approved');

    value.createApprovalRequest(input('executed-decision'), 1_000);
    value.decideApprovalRequest('executed-decision', 'approved', 1_100);
    value.claimApprovalExecution(
      'executed-decision',
      {
        runId: 'run-1',
        toolName: 'workspace.write',
        canonicalArguments: input().canonicalArguments,
      },
      1_200,
    );
    expect(() => value.decideApprovalRequest('executed-decision', 'denied', 1_300)).toThrow(
      'not pending (status: executed)',
    );
  });

  it('expires, denies, serializes concurrent decisions, and survives reopen without public secrets', async () => {
    const { root, value } = await store();
    value.createApprovalRequest(input('expired', 1_500), 1_000);
    expect(() => value.decideApprovalRequest('expired', 'approved', 1_500)).toThrow('expired');
    expect(value.getApprovalRequest('expired')?.status).toBe('expired');

    value.createApprovalRequest(input('denied'), 1_000);
    expect(value.decideApprovalRequest('denied', 'denied', 1_100).status).toBe('denied');

    value.createApprovalRequest(input('race'), 1_000);
    const outcomes = ['approved', 'denied'].map((decision) => {
      try {
        return value.decideApprovalRequest('race', decision as 'approved' | 'denied', 1_200).status;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(
      outcomes.filter((outcome) => outcome === 'approved' || outcome === 'denied'),
    ).toHaveLength(1);

    const secretArguments = canonicalizeApprovalArguments({
      path: 'notes.txt',
      token: 'private-token-value',
      password: 'private-password-value',
    });
    value.createApprovalRequest(
      {
        ...input('restart'),
        canonicalArguments: secretArguments,
        payloadHash: approvalPayloadHash('run-1', 'workspace.write', secretArguments),
        target: 'Bearer private-token',
      },
      1_000,
    );
    value.close();
    stores.splice(stores.indexOf(value), 1);
    const reopened = new DatabaseStore(openAppDatabase(root));
    stores.push(reopened);
    const pending = reopened.getApprovalRequest('restart');
    expect(pending?.status).toBe('pending');
    if (!pending) throw new Error('Pending approval did not survive reopen');
    const stored = JSON.stringify(
      reopened.database.raw.prepare('SELECT * FROM approval_requests WHERE id = ?').get('restart'),
    );
    expect(stored).not.toContain('private-token-value');
    expect(stored).not.toContain('private-password-value');
    expect(stored).not.toContain('private-token');
    const publicValue = publicApprovalRequest(pending);
    expect(publicValue.target).toBe('notes.txt');
    const event = createEvent('approval.requested', { ...publicValue });
    expect(JSON.stringify({ publicValue, event })).not.toContain('private-token-value');
    expect(JSON.stringify({ publicValue, event })).not.toContain('private-password-value');
  });

  it('persists versioned allowlisted previews for workspace writes and computer actions', async () => {
    const { value } = await store();
    const writeArguments = canonicalizeApprovalArguments({
      path: 'release/notes.txt',
      content: 'Deploy release\nBearer private-token-value',
      ignored: 'must-not-be-persisted',
    });
    value.createApprovalRequest(
      {
        ...input('write-preview'),
        canonicalArguments: writeArguments,
        payloadHash: approvalPayloadHash('run-1', 'workspace.write', writeArguments),
      },
      1_000,
    );

    const write = publicApprovalRequest(
      value.getApprovalRequest('write-preview') as NonNullable<
        ReturnType<typeof value.getApprovalRequest>
      >,
    );
    expect(write.preview).toMatchObject({
      version: 1,
      kind: 'workspace.write',
      context: { source: 'web', client: 'Web client', sessionId: 'session-1' },
    });
    expect(write.preview.fields).toEqual(
      expect.arrayContaining([
        { label: 'Path', value: 'release/notes.txt' },
        { label: 'Content size', value: '41 UTF-8 bytes' },
        { label: 'Content SHA-256', value: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ]),
    );
    expect(JSON.stringify(write)).not.toContain('Deploy release');

    const computerArguments = canonicalizeApprovalArguments({
      action: 'click',
      arguments: {
        pid: 42,
        element: 7,
        coordinate: [120, 240],
        password: 'private-password-value',
        ignored: 'nested-value-must-not-be-persisted',
      },
    });
    value.createApprovalRequest(
      {
        ...input('computer-preview'),
        toolName: 'computer.use',
        canonicalArguments: computerArguments,
        payloadHash: approvalPayloadHash('run-1', 'computer.use', computerArguments),
        requiredPermission: 'execute',
        risk: 'high · external',
        target: 'click',
      },
      1_000,
    );
    const computer = publicApprovalRequest(
      value.getApprovalRequest('computer-preview') as NonNullable<
        ReturnType<typeof value.getApprovalRequest>
      >,
    );
    expect(computer.preview).toMatchObject({ version: 1, kind: 'computer.use' });
    expect(computer.preview.fields).toEqual(
      expect.arrayContaining([
        { label: 'Action', value: 'click' },
        { label: 'Process ID', value: '42' },
        { label: 'Element', value: '7' },
        { label: 'Coordinate', value: '[120,240]' },
      ]),
    );

    const stored = JSON.stringify(
      value.database.raw
        .prepare(
          "SELECT arguments_preview FROM approval_requests WHERE id IN ('write-preview', 'computer-preview') ORDER BY id",
        )
        .all(),
    );
    expect(stored).not.toContain('private-token-value');
    expect(stored).not.toContain('private-password-value');
    expect(stored).not.toContain('must-not-be-persisted');
    expect(stored).not.toContain('nested-value-must-not-be-persisted');
  });

  it('never stores or publishes credentials from opaque approval text fields', async () => {
    const { value } = await store();
    const secrets = {
      password: 'password=hunter2',
      apiKey: 'api_key: abc123-not-public',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature',
      signedUrl: 'https://example.com/file?X-Amz-Credential=private&X-Amz-Signature=secret',
    };
    const requests = [
      {
        id: 'opaque-write',
        toolName: 'workspace.write',
        arguments: { path: 'safe.txt', content: Object.values(secrets).join('\n') },
      },
      {
        id: 'opaque-computer',
        toolName: 'computer.use',
        arguments: { action: 'set_value', arguments: { pid: 42, element: 7, value: secrets.jwt } },
      },
      {
        id: 'opaque-command',
        toolName: 'workspace.command',
        arguments: {
          command: `${secrets.password} ${secrets.signedUrl}`,
          args: [secrets.password, secrets.signedUrl],
        },
      },
      {
        id: 'opaque-schedule',
        toolName: 'schedule.create',
        arguments: {
          name: 'Nightly task',
          type: 'cron',
          expression: '0 0 * * *',
          agentInput: secrets.apiKey,
        },
      },
      {
        id: 'opaque-agent',
        toolName: 'agent.dispatch',
        arguments: { agent: 'local', prompt: secrets.password },
      },
    ];
    const publicValues = requests.map((request) => {
      const canonicalArguments = canonicalizeApprovalArguments(request.arguments);
      value.createApprovalRequest(
        {
          ...input(request.id),
          toolName: request.toolName,
          canonicalArguments,
          payloadHash: approvalPayloadHash('run-1', request.toolName, canonicalArguments),
        },
        1_000,
      );
      return publicApprovalRequest(
        value.getApprovalRequest(request.id) as NonNullable<
          ReturnType<typeof value.getApprovalRequest>
        >,
      );
    });
    const persisted = JSON.stringify(
      value.database.raw.prepare('SELECT arguments_preview FROM approval_requests').all(),
    );
    const exposed = JSON.stringify({
      approvals: publicValues,
      events: publicValues.map((approval) => createEvent('approval.requested', { ...approval })),
    });
    for (const secret of Object.values(secrets)) {
      expect(persisted).not.toContain(secret);
      expect(exposed).not.toContain(secret);
    }
    expect(publicValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          preview: expect.objectContaining({
            fields: expect.arrayContaining([
              { label: 'Content size', value: expect.stringContaining('UTF-8 bytes') },
              { label: 'Content SHA-256', value: expect.stringMatching(/^[a-f0-9]{64}$/u) },
            ]),
          }),
        }),
      ]),
    );
  });

  it('scrubs legacy generic argument previews when an existing database is reopened', async () => {
    const { root, value } = await store();
    value.createApprovalRequest(input('legacy-preview'), 1_000);
    value.createApprovalRequest(input('malformed-preview'), 1_000);
    value.createApprovalRequest(input('valid-preview'), 1_000);
    const validBefore = (
      value.database.raw
        .prepare('SELECT arguments_preview AS preview FROM approval_requests WHERE id = ?')
        .get('valid-preview') as { preview: string }
    ).preview;
    value.database.raw
      .prepare('UPDATE approval_requests SET arguments_preview = ? WHERE id = ?')
      .run('{"content":"password=hunter2","path":"notes.txt"}', 'legacy-preview');
    value.database.raw
      .prepare('UPDATE approval_requests SET arguments_preview = ? WHERE id = ?')
      .run('{"version":1}', 'malformed-preview');
    value.close();
    stores.splice(stores.indexOf(value), 1);

    const reopened = new DatabaseStore(openAppDatabase(root));
    stores.push(reopened);
    const persisted = JSON.stringify(
      reopened.database.raw
        .prepare('SELECT arguments_preview FROM approval_requests WHERE id = ?')
        .get('legacy-preview'),
    );
    expect(persisted).not.toContain('hunter2');
    expect(
      publicApprovalRequest(reopened.getApprovalRequest('legacy-preview') as never).preview,
    ).toEqual(expect.objectContaining({ version: 1, kind: 'legacy', fields: [] }));
    expect(
      publicApprovalRequest(reopened.getApprovalRequest('malformed-preview') as never).preview,
    ).toEqual(expect.objectContaining({ version: 1, kind: 'legacy', fields: [] }));
    expect(
      (
        reopened.database.raw
          .prepare('SELECT arguments_preview AS preview FROM approval_requests WHERE id = ?')
          .get('valid-preview') as { preview: string }
      ).preview,
    ).toBe(validBefore);
  });
});
