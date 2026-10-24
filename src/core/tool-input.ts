import { ToolExecutionError } from './tool-errors.js';

export const malformedArgumentsKey = '__nuaai_malformed_arguments__';

export class ToolInputError extends ToolExecutionError {
  constructor(detail: string) {
    super(
      `INVALID_TOOL_ARGUMENTS: ${detail}. This invocation was not executed. Supply a complete schema-valid tool request; raw text and command fragments are not executable.`,
      'INVALID_TOOL_ARGUMENTS',
      'not_executed',
      'repair_arguments',
    );
    this.name = 'ToolInputError';
  }
}

export function decodeToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === 'string') {
    const fenced = value.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu);
    try {
      const parsed: unknown = JSON.parse(fenced?.[1] ?? value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      return {
        [malformedArgumentsKey]: { raw: value, reason: 'Tool arguments are not a JSON object' },
      };
    }
  }
  return {
    [malformedArgumentsKey]: { raw: value, reason: 'Tool arguments are not a JSON object' },
  };
}
