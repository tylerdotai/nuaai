import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import type { InputAttachment } from '../web/attachments.js';
import type { Draft } from './tui-commands.js';

const recordSchema = z.object({
  draft: z.object({ text: z.string(), cursor: z.number().int().nonnegative() }),
  history: z.array(z.string()),
  pendingSubmissions: z.record(z.string(), z.string()).default({}),
  attachments: z.array(z.object({ name: z.string(), data: z.string() })),
});
type Record = z.infer<typeof recordSchema>;
const documentSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().nullable(),
  threadId: z.string().nullable(),
  threads: z.record(z.string(), recordSchema),
});
const empty = (): Record => ({
  draft: { text: '', cursor: 0 },
  history: [],
  attachments: [],
  pendingSubmissions: {},
});

export function useTuiComposer(root: string, baseUrl: string, onError: (error: string) => void) {
  const [initial] = useState(() => {
    const directory = resolve(root, '.nuaai');
    const key = createHash('sha256').update(baseUrl).digest('hex').slice(0, 16);
    const path = resolve(directory, `tui-drafts-${key}.json`);
    let document: z.infer<typeof documentSchema> = {
      version: 1,
      sessionId: null,
      threadId: null,
      threads: {},
    };
    let failure: string | null = null;
    try {
      document = documentSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        failure = `Draft recovery: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { directory, path, document, failure };
  });
  const document = useRef(initial.document);
  const owner = useRef<string | null>(null);
  const current = useRef<Record>(empty());
  const history = useRef<string[]>([]);
  const [record, setRecord] = useState(current.current);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current || initial.failure) return;
    try {
      mkdirSync(initial.directory, { recursive: true, mode: 0o700 });
      const temporary = `${initial.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(document.current)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, initial.path);
      dirty.current = false;
    } catch (error) {
      errorHandler.current(
        `Draft persistence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [initial]);
  const schedule = useCallback(() => {
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 150);
  }, [flush]);
  const update = useCallback(
    (next: Record) => {
      current.current = next;
      history.current = next.history;
      if (owner.current) {
        document.current.threads[owner.current] = next;
        schedule();
      }
      setRecord(next);
    },
    [schedule],
  );
  useEffect(() => {
    if (initial.failure) errorHandler.current(initial.failure);
    return flush;
  }, [initial, flush]);
  const actions = useMemo(
    () => ({
      setDraft: (value: Draft | ((previous: Draft) => Draft)) =>
        update({
          ...current.current,
          draft: typeof value === 'function' ? value(current.current.draft) : value,
        }),
      setAttachments: (
        value: InputAttachment[] | ((previous: InputAttachment[]) => InputAttachment[]),
      ) =>
        update({
          ...current.current,
          attachments: typeof value === 'function' ? value(current.current.attachments) : value,
        }),
      submissionKey: (threadId: string, identity: string): string => {
        const previous =
          threadId === owner.current
            ? current.current
            : (document.current.threads[threadId] ?? empty());
        const fingerprint = createHash('sha256').update(identity).digest('hex');
        let key = previous.pendingSubmissions[fingerprint];
        if (!key) {
          key = randomUUID();
          const next = {
            ...previous,
            pendingSubmissions: { ...previous.pendingSubmissions, [fingerprint]: key },
          };
          document.current.threads[threadId] = next;
          if (threadId === owner.current) update(next);
          else schedule();
        }
        flush();
        if (dirty.current)
          throw new Error('Pending submission could not be saved. No run was submitted.');
        return key;
      },
      accept: (
        threadId: string,
        text: string,
        submitted: Draft,
        attachments: InputAttachment[],
        identity: string,
      ) => {
        const previous =
          threadId === owner.current
            ? current.current
            : (document.current.threads[threadId] ?? empty());
        const pendingSubmissions = { ...previous.pendingSubmissions };
        delete pendingSubmissions[createHash('sha256').update(identity).digest('hex')];
        const next = {
          ...previous,
          pendingSubmissions,
          history: [...previous.history, text],
          draft: previous.draft.text === submitted.text ? { text: '', cursor: 0 } : previous.draft,
          attachments:
            JSON.stringify(previous.attachments) === JSON.stringify(attachments)
              ? []
              : previous.attachments,
        };
        document.current.threads[threadId] = next;
        if (threadId === owner.current) update(next);
        else schedule();
      },
      activate: (sessionId: string, threadId: string | null, carry = false) => {
        if (owner.current === threadId) return;
        const previous = current.current;
        owner.current = threadId;
        const next = threadId
          ? (document.current.threads[threadId] ??
            (carry
              ? { ...empty(), draft: previous.draft, attachments: previous.attachments }
              : empty()))
          : empty();
        document.current.sessionId = sessionId;
        document.current.threadId = threadId;
        update(next);
        schedule();
      },
    }),
    [update, schedule, flush],
  );
  return {
    ...actions,
    draft: record.draft,
    attachments: record.attachments,
    history,
    selection: initial.document,
    recoveryError: initial.failure,
  };
}
