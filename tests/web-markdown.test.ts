import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownContent } from '../src/web/components/MarkdownContent.js';

describe('MarkdownContent', () => {
  it('renders GFM structure and code controls as semantic content', () => {
    const markdown = [
      '## Review',
      '',
      '- one',
      '- two',
      '',
      '| File | Result |',
      '| --- | --- |',
      '| `src/server.ts` | Pass |',
      '',
      '> Evidence first.',
      '',
      '```ts',
      'const safe = true;',
      '```',
      '',
      '[Source](https://example.com/report)',
    ].join('\n');

    const markup = renderToStaticMarkup(createElement(MarkdownContent, { markdown }));

    expect(markup).toContain('<h2>Review</h2>');
    expect(markup).toContain('<ul>');
    expect(markup).toContain('<table>');
    expect(markup).toContain('<blockquote>');
    expect(markup).toContain('language-ts');
    expect(markup).toContain('data-language="ts"');
    expect(markup).toContain('aria-label="Copy code block"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  it('keeps hostile HTML inert and removes dangerous link protocols', () => {
    const markdown = [
      '<script>globalThis.compromised = true</script>',
      '<img src="x" onerror="globalThis.compromised = true">',
      '[unsafe](javascript:alert(1))',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
    ].join('\n\n');

    const markup = renderToStaticMarkup(createElement(MarkdownContent, { markdown }));

    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('data:text/html');
    expect(markup).not.toContain('onerror=');
  });

  it('renders a large response without truncating its final content', () => {
    const markdown = `# Large report\n\n${Array.from(
      { length: 2_500 },
      (_, index) => `- Evidence item ${index}`,
    ).join('\n')}\n\nFinal verified conclusion.`;

    const markup = renderToStaticMarkup(createElement(MarkdownContent, { markdown }));

    expect(markdown.length).toBeGreaterThan(20_000);
    expect(markup).toContain('<h1>Large report</h1>');
    expect(markup).toContain('Evidence item 2499');
    expect(markup).toContain('Final verified conclusion.');
  });
});
