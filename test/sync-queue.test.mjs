import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeQueue as createDesktopRealtimeQueue, createSyncQueue as createDesktopSyncQueue } from "../desktop/src/lib/sync-queue.ts";
import { createRealtimeQueue as createMobileRealtimeQueue, createSyncQueue as createMobileSyncQueue } from "../mobile/src/sync-queue.ts";

for (const [name, createSyncQueue, createRealtimeQueue] of [["desktop", createDesktopSyncQueue, createDesktopRealtimeQueue], ["mobile", createMobileSyncQueue, createMobileRealtimeQueue]]) {
  test(`${name} repeats a sync queued during the current request`, async () => {
    let releaseCurrent;
    let resolveNext;
    let calls = 0;
    let running = 0;
    let maxRunning = 0;
    const current = new Promise((resolve) => { releaseCurrent = resolve; });
    const next = new Promise((resolve) => { resolveNext = resolve; });
    const sync = createSyncQueue(async () => {
      calls += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (calls === 1) await current;
      else resolveNext();
      running -= 1;
    });

    const first = sync();
    await Promise.resolve();
    sync();
    sync();
    assert.equal(calls, 1);
    releaseCurrent();
    await first;
    await next;

    assert.equal(calls, 2);
    assert.equal(maxRunning, 1);
  });

  test(`${name} applies realtime cursors in order and recovers gaps`, async () => {
    let cursor = 0;
    let recoveries = 0;
    const applied = [];
    const queue = createRealtimeQueue(
      () => cursor,
      (next) => { cursor = Math.max(cursor, next); },
      async (event) => { applied.push(event.cursor); return true; },
      async () => { recoveries += 1; cursor = 3; },
    );

    queue.enqueue({ cursor: 1 });
    queue.enqueue({ cursor: 2 });
    await queue.retry();
    queue.enqueue({ cursor: 4 });
    await queue.retry();

    assert.deepEqual(applied, [1, 2, 4]);
    assert.equal(recoveries, 1);
    assert.equal(cursor, 4);
    queue.enqueue({ cursor: 4 });
    await queue.retry();
    assert.deepEqual(applied, [1, 2, 4]);
  });

  test(`${name} retries a pending gap after a temporary reconnect recovery failure`, async () => {
    let cursor = 0;
    let recoveries = 0;
    const applied = [];
    const queue = createRealtimeQueue(
      () => cursor,
      (next) => { cursor = Math.max(cursor, next); },
      async (event) => { applied.push(event.cursor); return true; },
      async () => {
        recoveries += 1;
        if (recoveries > 1) cursor = 1;
      },
    );

    queue.enqueue({ cursor: 2 });
    await queue.retry();
    assert.deepEqual(applied, []);
    await queue.retry();

    assert.deepEqual(applied, [2]);
    assert.equal(recoveries, 2);
    assert.equal(cursor, 2);
  });
}
