import { type SetStateAction, useRef, useState } from 'react';
import type { Draft } from './tui-commands.js';
import type { ScheduleForm } from './tui-forms.js';
import type { PickerState } from './tui-picker.js';
import type { TuiView } from './tui-state.js';

type Frame = {
  picker: PickerState | null;
  form: ScheduleForm | null;
  formDraft: Draft;
  view: TuiView;
};

// Navigation owns transient editors; a form must never overwrite the thread's durable composer.
export function useTuiNavigation(view: TuiView, onView: (view: TuiView) => void) {
  const [frame, setFrame] = useState<Frame>({
    picker: null,
    form: null,
    formDraft: { text: '', cursor: 0 },
    view,
  });
  const current = useRef(frame);
  const history = useRef<Frame[]>([]);
  const update = (next: Partial<Frame>): void => {
    current.current = { ...current.current, ...next };
    setFrame(current.current);
  };
  const push = (next: Partial<Frame>): void => {
    history.current.push({ ...current.current, view });
    update(next);
  };
  return {
    ...frame,
    setPicker(value: SetStateAction<PickerState | null>) {
      update({ picker: typeof value === 'function' ? value(current.current.picker) : value });
    },
    setForm(value: ScheduleForm | null) {
      update({ form: value });
    },
    setFormDraft(value: SetStateAction<Draft>) {
      update({ formDraft: typeof value === 'function' ? value(current.current.formDraft) : value });
    },
    pushPicker(picker: PickerState) {
      push({ picker, form: null });
    },
    pushForm(form: ScheduleForm) {
      const text = form.values[form.step] ?? '';
      push({ picker: null, form, formDraft: { text, cursor: text.length } });
    },
    back(project?: (picker: PickerState) => PickerState) {
      const previous = history.current.pop();
      if (!previous) {
        update({ picker: null, form: null });
        return;
      }
      update({
        ...previous,
        picker: previous.picker && project ? project(previous.picker) : previous.picker,
      });
      onView(previous.view);
      return previous;
    },
    close() {
      history.current.length = 0;
      update({ picker: null, form: null });
    },
  };
}
