const SECRET_NAME_PATTERN =
  'token|secret|password|passwd|api[_-]?key|authorization|cookie|master[_-]?key|access[_-]?token|refresh[_-]?token|credential|signature';
const SECRET_ASSIGNMENT_KEY_PATTERN = `(?:[A-Za-z0-9]+[_-])*(${SECRET_NAME_PATTERN})`;
const SECRET_KEY = new RegExp(`(?:${SECRET_NAME_PATTERN})`, 'i');
const QUOTED_SECRET_ASSIGNMENT = new RegExp(
  `(["'])(${SECRET_ASSIGNMENT_KEY_PATTERN})\\1(\\s*:\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;}&}]+)`,
  'gi',
);
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_ASSIGNMENT_KEY_PATTERN})(\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;}&}]+)`,
  'gi',
);
const maxStructuredDepth = 64;
const maxStructuredNodes = 10_000;

interface RedactionFrame {
  input: Record<string, unknown> | unknown[];
  output: Record<string, unknown> | unknown[];
  entries: Array<[string, unknown]>;
  index: number;
  depth: number;
}

function looksLikeStructuredJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

function redactPlainText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
    .replace(
      QUOTED_SECRET_ASSIGNMENT,
      (_match, quote: string, key: string, _baseName: string, separator: string) =>
        `${quote}${key}${quote}${separator}${quote}[REDACTED]${quote}`,
    )
    .replace(SECRET_ASSIGNMENT, '$1$3[REDACTED]');
}

function redactedContainer(
  value: Record<string, unknown> | unknown[],
): Record<string, unknown> | unknown[] {
  return Array.isArray(value) ? [] : Object.create(null);
}

function redactNestedValue(value: unknown): unknown {
  if (typeof value === 'string')
    return looksLikeStructuredJson(value) ? '[REDACTED]' : redactPlainText(value);
  return value;
}

function redactBoundedValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return redactNestedValue(value);

  const rootInput = value as Record<string, unknown> | unknown[];
  const rootOutput = redactedContainer(rootInput);
  const seen = new WeakSet<object>([rootInput]);
  const stack: RedactionFrame[] = [
    {
      input: rootInput,
      output: rootOutput,
      entries: Object.entries(rootInput),
      index: 0,
      depth: 0,
    },
  ];
  let nodes = 1;

  while (stack.length > 0) {
    const frame = stack.at(-1) as RedactionFrame;
    if (frame.index >= frame.entries.length) {
      stack.pop();
      continue;
    }
    const [key, entry] = frame.entries[frame.index] as [string, unknown];
    frame.index += 1;
    nodes += 1;
    if (nodes > maxStructuredNodes)
      throw new Error('Structured value exceeds redaction node limit');

    if (!Array.isArray(frame.input) && SECRET_KEY.test(key)) {
      (frame.output as Record<string, unknown>)[key] = '[REDACTED]';
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      (frame.output as Record<string, unknown>)[key] = redactNestedValue(entry);
      continue;
    }
    if (frame.depth + 1 > maxStructuredDepth)
      throw new Error('Structured value exceeds redaction depth limit');
    if (seen.has(entry)) {
      (frame.output as Record<string, unknown>)[key] = '[REDACTED]';
      continue;
    }
    const input = entry as Record<string, unknown> | unknown[];
    const output = redactedContainer(input);
    (frame.output as Record<string, unknown>)[key] = output;
    seen.add(input);
    stack.push({
      input,
      output,
      entries: Object.entries(input),
      index: 0,
      depth: frame.depth + 1,
    });
  }

  return rootOutput;
}

function redactStructuredJson(value: string): string | undefined {
  if (!looksLikeStructuredJson(value)) return undefined;
  try {
    return JSON.stringify(redactBoundedValue(JSON.parse(value.trim())));
  } catch {
    return JSON.stringify('[REDACTED]');
  }
}

export function redactText(value: string): string {
  const structured = redactStructuredJson(value);
  return structured ?? redactPlainText(value);
}

export function redactValue(value: unknown): unknown {
  try {
    return redactBoundedValue(value);
  } catch {
    return '[REDACTED]';
  }
}
