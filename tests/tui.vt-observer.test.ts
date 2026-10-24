import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('counts composed emoji and flag graphemes as terminal cells instead of reporting false frame overflow', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      `
import ast, codecs, re
from pathlib import Path
module = ast.parse(Path('scripts/terminal-smoke.py').read_text())
node = next(item for item in module.body if isinstance(item, ast.ClassDef) and item.name == 'Screen')
exec(compile(ast.Module(body=[node], type_ignores=[]), '<VT observer>', 'exec'))
for glyph in ['👩‍💻', '🇺🇸', '👍🏽']:
    screen = Screen(2,16)
    screen.alt = True
    line = glyph + (' ' * 14)
    screen.feed((line + '\\r\\n' + line).encode())
    assert screen.scrolls == 0, (glyph, screen.scrolls)
screen = Screen(2,16)
screen.alt = True
screen.feed(('X' * 33).encode())
assert screen.scrolls == 1, 'real overflow must still fail'
print('grapheme-width-pass')
`,
    ],
    { encoding: 'utf8' },
  );
  expect(result.trim()).toBe('grapheme-width-pass');
});
