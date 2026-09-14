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

function redactStructuredJson(value: string): string | undefined {
  const trimmed = value.trim();
  const isObject = trimmed.startsWith('{') && trimmed.endsWith('}');
  const isArray = trimmed.startsWith('[') && trimmed.endsWith(']');
  if (!isObject && !isArray) return undefined;
  try {
    return JSON.stringify(redactValue(JSON.parse(trimmed)));
  } catch {
    return undefined;
  }
}

export function redactText(value: string): string {
  const structured = redactStructuredJson(value);
  if (structured !== undefined) return structured;
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

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(entry),
      ]),
    );
  }
  return value;
}
