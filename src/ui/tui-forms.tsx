import { Box, Text } from 'ink';
import { TuiEditor } from './tui-editor.js';
import type { TuiScheduleDraft } from './tui-schedule.js';

export const scheduleFields = [
  { label: 'Automation name', hint: 'A short, recognizable name.' },
  { label: 'Schedule type', hint: 'manual · interval · cron · once · startup' },
  {
    label: 'Schedule expression',
    hint: 'manual/startup: manual · interval: milliseconds · cron: five fields · once: ISO date',
  },
  {
    label: 'Agent instructions',
    hint: 'The exact instructions the agent should run. Alt-Enter inserts a newline.',
  },
];
export interface ScheduleForm {
  step: number;
  values: string[];
  original?: TuiScheduleDraft;
}
export function scheduleForm(original?: TuiScheduleDraft): ScheduleForm {
  return {
    step: 0,
    values: [
      original?.name ?? '',
      original?.type ?? 'manual',
      original?.expression ?? 'manual',
      original?.agentInput ?? '',
    ],
    original,
  };
}
export function scheduleFromForm(form: ScheduleForm, input: string): TuiScheduleDraft {
  const values = [...form.values];
  values[form.step] = input.trim();
  if (values.some((value) => !value)) throw new Error('All automation fields are required.');
  const type = values[1] as TuiScheduleDraft['type'];
  if (!['manual', 'interval', 'cron', 'once', 'startup'].includes(type))
    throw new Error('Choose manual, interval, cron, once, or startup.');
  const expression =
    type === 'once' && !/^\d+$/u.test(values[2])
      ? String(new Date(values[2]).getTime())
      : values[2];
  if (type === 'once' && !Number.isFinite(Number(expression)))
    throw new Error('Enter a valid ISO date or epoch timestamp.');
  return {
    ...form.original,
    name: values[0],
    type,
    expression,
    agentInput: values[3],
    enabled: form.original?.enabled ?? true,
  };
}
export function TuiScheduleForm({
  form,
  input,
  cursor,
  columns,
}: { form: ScheduleForm; input: string; cursor: number; columns: number }): React.JSX.Element {
  const field = scheduleFields[form.step];
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {form.original ? 'Edit automation' : 'Create automation'} · {form.step + 1}/
        {scheduleFields.length}
      </Text>
      <Text color="blue" bold>
        {field.label}
      </Text>
      <Text dimColor>{field.hint}</Text>
      <TuiEditor input={input} cursor={cursor} columns={columns} />
      <Text dimColor>Enter next · Ctrl-B previous · Esc cancel · final review before saving</Text>
    </Box>
  );
}
