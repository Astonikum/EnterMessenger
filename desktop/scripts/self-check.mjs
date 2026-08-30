import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRealtimeQueue, createSyncQueue } from "../src/lib/sync-queue.ts";
import { writeMessageCache } from "../src/lib/message-cache.ts";
import { applyLocalSettings, DEFAULT_LOCAL_SETTINGS, readLocalSettings, writeLocalSettings } from "../src/lib/local-settings.ts";
import { isManagedDeviceResponse } from "../src/lib/enter-api-contract.ts";
import { normalizeServerAddress, resolveServerResource } from "../src/lib/server-address.ts";

const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const macosConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"));
assert.equal(tauriConfig.version, "0.2.3");
assert.equal(tauriConfig.app.windows[0].label, "main");
assert.ok(tauriConfig.bundle.icon.includes("icons/icon.icns"));
assert.equal(macosConfig.bundle.category, "SocialNetworking");
assert.deepEqual(macosConfig.bundle.icon, ["icons/icon.icns"]);
assert.equal(macosConfig.bundle.macOS.bundleName, "Enter Messenger");
assert.equal(macosConfig.bundle.macOS.bundleVersion, tauriConfig.version);
assert.equal(macosConfig.bundle.macOS.signingIdentity, "-");
assert.equal(macosConfig.bundle.macOS.infoPlist, "Info.plist");

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.window = globalThis;

assert.deepEqual(readLocalSettings(), DEFAULT_LOCAL_SETTINGS);
const customSettings = { ...DEFAULT_LOCAL_SETTINGS, theme: "light", fontScale: 1.1, density: "compact", accent: "blue", locale: "en", notifications: { ...DEFAULT_LOCAL_SETTINGS.notifications, desktop: false, sound: true, preview: false }, cachePolicy: "minimal", debug: { showCommonElements: true } };
writeLocalSettings(customSettings);
assert.deepEqual(readLocalSettings(), customSettings);
globalThis.matchMedia = () => ({ matches: true });
globalThis.document = { documentElement: { dataset: {}, style: { setProperty: () => undefined } } };
applyLocalSettings(customSettings);
assert.equal(document.documentElement.dataset.theme, "light");
assert.equal(document.documentElement.dataset.density, "compact");
assert.equal(document.documentElement.dataset.commonDebug, "true");
assert.equal(document.documentElement.lang, "en");

assert.equal(isManagedDeviceResponse({ deviceId: "desktop-1", platform: "desktop", name: "Desktop", appVersion: "0.2.0", createdAt: 1_700_000_000_000, lastSeenAt: 1_700_000_000_000, current: true, revokedAt: null }), true);
assert.equal(normalizeServerAddress("31.77.151.34:50121"), "http://31.77.151.34:50121");
assert.equal(resolveServerResource("http://31.77.151.34:50121", "/logo.png"), "http://31.77.151.34:50121/logo.png");

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
