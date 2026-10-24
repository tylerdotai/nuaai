import { startDaemon } from '../../dist/daemon.js';

const root = process.env.NUAAI_E2E_ROOT;
if (!root || process.env.NUAAI_TEST_MODE !== '1')
  throw new Error('An isolated E2E root and test mode are required.');
const daemon = await startDaemon(root);
// Observe the actual built runtime's provider boundary without adding
// fixture-specific branches or private-context endpoints to shipped code.
const provider = daemon.runtime.options.providers.get('deterministic');
const stream = provider.stream.bind(provider);
provider.stream = async function* (request) {
  if (request.conversationId?.startsWith('knowledge:')) {
    const payload = JSON.parse(request.messages.at(-1)?.content ?? '{}');
    const preference = String(payload.input ?? '').match(
      /^I prefer (blue|green) controls for the browser learning acceptance project\.$/u,
    );
    const previous = payload.existing?.find(
      (note) => note.automatic && note.content.startsWith('Browser acceptance project prefers '),
    );
    yield {
      type: 'done',
      text: JSON.stringify({
        candidates: preference
          ? [
              {
                kind: 'preference',
                topic: 'browser.ui.controls',
                content: `Browser acceptance project prefers ${preference[1]} controls.`,
                scope: 'workspace',
                sourceQuote: payload.input,
                evidenceCallIds: [],
                confidence: 'high',
                ...(previous ? { supersedes: previous.id } : {}),
              },
            ]
          : [],
      }),
    };
    return;
  }
  const input = request.messages.at(-1)?.content ?? '';
  const identityProbe = input.match(/^browser identity smoke ([12])$/u);
  if (identityProbe) {
    const prompt = request.systemPrompt ?? '';
    if (
      !prompt.includes('WEB_IDENTITY_SOUL_MARKER') ||
      !prompt.includes(`WEB_IDENTITY_AGENTS_MARKER_${identityProbe[1]}`)
    )
      throw new Error(
        'Deterministic identity fixture did not receive both expected instruction sources.',
      );
    const text = `Verified instruction snapshot ${identityProbe[1]} at provider boundary.`;
    yield { type: 'delta', text };
    yield { type: 'done', text };
    return;
  }
  yield* stream(request);
};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void daemon.stop().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
