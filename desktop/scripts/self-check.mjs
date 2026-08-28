import assert from "node:assert/strict";
import { createRealtimeQueue, createSyncQueue } from "../src/lib/sync-queue.ts";
import { writeMessageCache } from "../src/lib/message-cache.ts";
import { applyLocalSettings, DEFAULT_LOCAL_SETTINGS, readLocalSettings, writeLocalSettings } from "../src/lib/local-settings.ts";

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.window = globalThis;

assert.deepEqual(readLocalSettings(), DEFAULT_LOCAL_SETTINGS);
const customSettings = { ...DEFAULT_LOCAL_SETTINGS, theme: "light", fontScale: 1.1, density: "compact", accent: "blue", locale: "en", notifications: { desktop: false, sound: true, preview: false }, cachePolicy: "minimal" };
writeLocalSettings(customSettings);
assert.deepEqual(readLocalSettings(), customSettings);
globalThis.matchMedia = () => ({ matches: true });
globalThis.document = { documentElement: { dataset: {}, style: { setProperty: () => undefined } } };
applyLocalSettings(customSettings);
assert.equal(document.documentElement.dataset.theme, "light");
assert.equal(document.documentElement.dataset.density, "compact");
assert.equal(document.documentElement.lang, "en");

const cachedMessages = Array.from({ length: 201 }, (_, index) => ({
  id: String(index),
  author: "me",
  text: "message",
  time: "12:00",
}));
writeMessageCache("self-check", { conversation: cachedMessages }, 42);
const cached = JSON.parse(values.get("enter-message-cache:self-check"));
assert.equal(cached.cursor, 0);
assert.equal(cached.messages.conversation.length, 200);

let syncRuns = 0;
let sync;
sync = createSyncQueue(async () => {
  syncRuns += 1;
  if (syncRuns === 1) void sync();
});
await sync();
assert.equal(syncRuns, 2);

let cursor = 0;
const applied = [];
const realtime = createRealtimeQueue(
  () => cursor,
  (nextCursor) => { cursor = nextCursor; },
  async (event) => { applied.push(event.cursor); return true; },
  async () => { throw new Error("unexpected recovery"); },
);
realtime.enqueue({ cursor: 1 });
realtime.enqueue({ cursor: 2 });
await realtime.retry();
assert.deepEqual(applied, [1, 2]);
assert.equal(cursor, 2);

console.log("desktop self-check: ok");
