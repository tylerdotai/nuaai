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
    expect(publicValue.target).toBe('Bearer [REDACTED]');
    const event = createEvent('approval.requested', { ...publicValue });
    expect(JSON.stringify({ publicValue, event })).not.toContain('private-token-value');
    expect(JSON.stringify({ publicValue, event })).not.toContain('private-password-value');
  });
});
