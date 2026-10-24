export async function abortableOperation<T>(
  operation: () => PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
      aborted,
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function* abortableStream<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal,
  onCleanupError: (error: unknown) => void,
): AsyncIterable<T> {
  signal.throwIfAborted();
  const iterator = stream[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await abortableOperation(() => iterator.next(), signal);
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    // A noncooperative async generator queues return() behind its pending next().
    // Request cleanup, but never hold the run's writer/queue waiting for that promise.
    if (!completed && iterator.return)
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(onCleanupError);
  }
}
