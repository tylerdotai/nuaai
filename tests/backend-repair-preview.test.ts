import { expect, it } from 'vitest';
import { buildApprovalPreview, buildTransientApprovalPreview } from '../src/core/approvals.js';

it('offers distinguishable bounded transient text while durable previews remain opaque', () => {
  const context = { permissionSource: 'web' };
  const first = buildTransientApprovalPreview(
    'workspace.write',
    { path: 'readme.md', content: `Ship cedar\npassword=hunter-fixture\n${'x'.repeat(10_000)}` },
    context,
  );
  const second = buildTransientApprovalPreview(
    'workspace.write',
    { path: 'readme.md', content: 'Ship pine' },
    context,
  );
  expect(JSON.stringify(first)).toContain('Ship cedar');
  expect(JSON.stringify(second)).toContain('Ship pine');
  expect(JSON.stringify(first)).not.toContain('hunter-fixture');
  expect(JSON.stringify(first)).toContain('[truncated]');
  expect(JSON.stringify(first).length).toBeLessThan(8_000);
  expect(
    JSON.stringify(
      buildApprovalPreview(
        'workspace.write',
        { path: 'readme.md', content: 'Ship cedar' },
        context,
      ),
    ),
  ).not.toContain('Ship cedar');
  const command = buildTransientApprovalPreview(
    'workspace.command',
    {
      command: 'curl',
      args: [
        '--token',
        'flag-fixture',
        'https://user:url-fixture@example.com',
        '-H',
        'Authorization: Bearer header-fixture',
        '--output',
        'weather.json',
      ],
    },
    context,
  );
  expect(JSON.stringify(command)).toContain('weather.json');
  expect(JSON.stringify(command)).toContain('curl');
  for (const secret of ['flag-fixture', 'url-fixture', 'header-fixture'])
    expect(JSON.stringify(command)).not.toContain(secret);
  const spaced = buildTransientApprovalPreview(
    'workspace.command',
    {
      command: 'fixture',
      args: ['--password', 'multiple words secret', '--token=other words hidden'],
    },
    context,
  );
  for (const secret of ['multiple', 'words', 'hidden'])
    expect(JSON.stringify(spaced)).not.toContain(secret);
  const protectedFile = buildTransientApprovalPreview(
    'workspace.write',
    { path: '.env', content: 'UNNAMED=protected-fixture' },
    context,
  );
  expect(JSON.stringify(protectedFile)).not.toContain('protected-fixture');
  const key = buildTransientApprovalPreview(
    'workspace.write',
    {
      path: 'notes.txt',
      content: '-----BEGIN PRIVATE KEY-----\nopaque-fixture\n-----END PRIVATE KEY-----',
    },
    context,
  );
  expect(JSON.stringify(key)).not.toContain('opaque-fixture');
});
