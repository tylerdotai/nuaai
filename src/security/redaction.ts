const SECRET_NAME_PATTERN =
  'token|secret|password|passwd|api[_-]?key|authorization|cookie|master[_-]?key|access[_-]?token|refresh[_-]?token|credential|signature';
const SECRET_KEY = new RegExp(`(?:${SECRET_NAME_PATTERN})`, 'i');
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_NAME_PATTERN})\\b(\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;}&]+)`,
  'gi',
);

export function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1$2[REDACTED]');
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
