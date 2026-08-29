export function createSyncQueue(run: () => Promise<void>) {
  let running: Promise<void> | null = null;
  let queued = false;

  return async function sync() {
    if (running) {
      queued = true;
      return running;
    }
    running = (async () => {
      do {
        queued = false;
        await run();
      } while (queued);
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  };
}

export type CursorEvent = { cursor: number };

export function createRealtimeQueue<T extends CursorEvent>(
  getCursor: () => number,
  advanceCursor: (cursor: number) => void,
  apply: (event: T) => Promise<boolean>,
  recover: () => Promise<void>,
) {
  const pending = new Map<number, T>();
  let running: Promise<void> | null = null;

  async function drain() {
    if (running) return running;
    const work = (async () => {
      while (pending.size > 0) {
        const cursor = Math.min(...pending.keys());
        if (cursor <= getCursor()) {
          pending.delete(cursor);
          continue;
        }
        if (cursor > getCursor() + 1) {
          const before = getCursor();
          await recover();
          if (getCursor() === before) return;
          continue;
        }
        const event = pending.get(cursor)!;
        if (!(await apply(event))) {
          const before = getCursor();
          await recover();
          if (getCursor() === before) return;
          continue;
        }
        pending.delete(cursor);
        advanceCursor(cursor);
      }
    })();
    running = work;
    try {
      await work;
    } finally {
      if (running === work) running = null;
    }
  }

  return {
    enqueue(event: T) {
      if (event.cursor <= getCursor() || pending.has(event.cursor)) return;
      pending.set(event.cursor, event);
      void drain();
    },
    retry: drain,
  };
}
