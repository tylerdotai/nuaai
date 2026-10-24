import { renderToString } from 'ink';
import { createElement } from 'react';
import { expect, it } from 'vitest';
import { TuiMarkdown } from '../src/ui/tui-markdown.js';

it('renders headings, emphasis, links and fenced code without mangling literal code', () => {
  const output = renderToString(
    createElement(TuiMarkdown, {
      content:
        '# Result\n\nThis is **bold** and `inline`.\n\n- Read [the docs](https://example.org/docs)\n\n```ts\nconst x = "**literal**";\n```',
    }),
    { columns: 80 },
  );
  expect(output).toContain('Result');
  expect(output).not.toContain('# Result');
  expect(output).toContain('This is bold and inline.');
  expect(output).toContain('the docs (https://example.org/docs)');
  expect(output).toContain('const x = "**literal**";');
  expect(output).not.toContain('```');
});

it('handles an unfinished streaming code fence and strips terminal control sequences', () => {
  const output = renderToString(
    createElement(TuiMarkdown, { content: 'Hello\u001b[2J\n```sh\nprintf "hello"' }),
    { columns: 40 },
  );
  expect(output).toContain('Hello');
  expect(output).toContain('printf "hello"');
  expect(output).not.toContain('\u001b[2J');
});
