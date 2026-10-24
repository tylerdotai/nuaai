import { expect, it } from 'vitest';
import { identityHarness } from './identity.harness.js';

it('does not advertise unavailable MCP execution or computer control while keeping diagnostic tools available', async () => {
  const h = await identityHarness();
  try {
    const created = await h.api('/api/sessions', {});
    const request = await h.run(created.body.thread.id);
    expect(request.systemPrompt).not.toContain('- computer.use:');
    expect(request.systemPrompt).not.toContain('- mcp.execute:');
    expect(request.systemPrompt).toContain('- mcp.status:');
  } finally {
    await h.close();
  }
}, 15000);

it('does not advertise disabled external dispatch to a model, even when the service object exists', async () => {
  const h = await identityHarness();
  try {
    const session = await h.api('/api/sessions', {});
    const request = await h.run(session.body.thread.id);
    const names = [
      ...(request.tools ?? []).map((tool) => tool.name),
      ...(request.dynamicTools ?? []).map((tool) => `${tool.namespace}.${tool.name}`),
    ];
    expect(names).not.toContain('agent.dispatch');
    expect(request.systemPrompt).not.toContain('- agent.dispatch:');
  } finally {
    await h.close();
  }
}, 15000);
