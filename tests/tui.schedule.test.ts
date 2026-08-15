import { describe, expect, it } from 'vitest';

import { parseScheduleCommand } from '../src/ui/tui-schedule.js';

describe('TUI schedule command parser', () => {
  it('parses a schedule creation command', () => {
    expect(parseScheduleCommand('nightly|interval|1h|summarize the workspace', 'create')).toEqual({
      name: 'nightly',
      type: 'interval',
      expression: '1h',
      agentInput: 'summarize the workspace',
      enabled: true,
    });
  });

  it('parses a schedule edit command with an id', () => {
    expect(parseScheduleCommand('schedule-1|hourly|cron|*/5 * * * *|check status', 'edit')).toEqual(
      {
        id: 'schedule-1',
        name: 'hourly',
        type: 'cron',
        expression: '*/5 * * * *',
        agentInput: 'check status',
        enabled: true,
      },
    );
  });

  it('rejects malformed commands and unsupported schedule types', () => {
    expect(() => parseScheduleCommand('too|short', 'create')).toThrow(
      'name|type|expression|agent input',
    );
    expect(() => parseScheduleCommand('name|unknown|1h|input', 'create')).toThrow(
      'Unsupported schedule type',
    );
    expect(() => parseScheduleCommand('|manual||input', 'create')).toThrow(
      'Schedule name is required',
    );
  });
});
