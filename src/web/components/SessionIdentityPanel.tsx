import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionIdentityStatus } from '../../core/identity.js';
import './session-identity.css';

export function SessionIdentityPanel({
  sessionId,
  request,
  onClose,
}: {
  sessionId: string;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  onClose: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<SessionIdentityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const generation = useRef(0);
  const current = useRef(sessionId);
  current.current = sessionId;
  const load = useCallback(
    async (refresh = false) => {
      const version = ++generation.current;
      const id = sessionId;
      setBusy(true);
      setError(null);
      try {
        let changed: SessionIdentityStatus | undefined;
        if (refresh)
          changed = await request<SessionIdentityStatus>(
            `/api/sessions/${encodeURIComponent(id)}/identity/refresh`,
            { method: 'POST', body: '{}' },
          );
        const observed = await request<SessionIdentityStatus>(
          `/api/sessions/${encodeURIComponent(id)}/identity`,
        );
        if (version !== generation.current || current.current !== id) return;
        if (observed.sessionId !== id || (changed && changed.id !== observed.id))
          throw new Error('Identity readback did not match the selected session.');
        setStatus(observed);
        setConfirming(false);
      } catch (cause) {
        if (version === generation.current && current.current === id)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (version === generation.current && current.current === id) setBusy(false);
      }
    },
    [sessionId, request],
  );
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    setStatus(null);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  return (
    <dialog
      ref={dialog}
      className="command-palette identity-dialog"
      aria-label="Session instruction sources"
      onCancel={onClose}
    >
      <div className="dialog-heading">
        <h2>Session instruction sources</h2>
        <button
          type="button"
          className="text-button"
          onClick={onClose}
          aria-label="Close instruction sources"
        >
          Close
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {status ? (
        <>
          <p>
            <strong>Revision {status.revision}</strong> · {status.origin}
          </p>
          <p>
            Workspace: <code>{status.workspaceRoot}</code>
          </p>
          <p>Captured {new Date(status.capturedAt).toLocaleString()}</p>
          <p>{status.precedence}</p>
          {status.inheritedFrom && (
            <p>Inherited from parent revision {status.inheritedFrom.revision}.</p>
          )}
          <ul>
            {status.sources.map((source, index) => (
              <li key={`${source.scope}-${source.name}-${index}`}>
                <strong>
                  {source.scope}/{source.name}
                </strong>{' '}
                — {source.status} · {source.bytesRead}
                {source.totalBytes === undefined ? '' : `/${source.totalBytes}`} bytes
                {source.errorCode ? ` · ${source.errorCode}` : ''}
              </li>
            ))}
          </ul>
          <p className="dialog-hint">
            Instruction text stays private. Refresh affects future runs; already admitted runs keep
            their original snapshot.
          </p>
        </>
      ) : (
        <p>{busy ? 'Loading source metadata…' : 'Source metadata unavailable.'}</p>
      )}
      {confirming ? (
        <>
          <p>Reload the same permitted instruction roots for this session?</p>
          <button
            type="button"
            className="header-button"
            disabled={busy}
            onClick={() => void load(true)}
          >
            Reload instruction files
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Keep current snapshot
          </button>
        </>
      ) : (
        <button
          type="button"
          className="header-button"
          disabled={busy || !status}
          onClick={() => setConfirming(true)}
        >
          Refresh identity
        </button>
      )}
    </dialog>
  );
}
