import assert from "node:assert/strict";
import * as AsyncStorageModule from "@react-native-async-storage/async-storage";
import {
  MAX_CACHED_MESSAGES_PER_CONVERSATION,
  MAX_OUTBOX_ATTEMPTS,
  MAX_OUTBOX_ENTRIES,
  limitMessageList,
  limitOutboxEntries,
  retryDelay,
  sanitizeMessagesByProfile,
  sanitizeOutboxByProfile,
} from "../src/storage-limits.ts";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  readSettings,
  writeSettings,
} from "../src/settings.ts";
import { getSuggestedServerAddress } from "../src/rn-address.ts";

const SENSITIVE_E2E_KEY_NAMES = [
  "encryptionPrivateKey",
  "signingPrivateKey",
  "deviceKey",
  "accountKey",
  "privateKey",
];

class MemoryAsyncStorage {
  #values = new Map();

  async getItem(key) {
    return this.#values.get(key) ?? null;
  }

  async setItem(key, value) {
    this.#values.set(key, String(value));
  }

  async removeItem(key) {
    this.#values.delete(key);
  }
}

const storage = new MemoryAsyncStorage();
Object.assign(AsyncStorageModule.default, {
  getItem: (key) => storage.getItem(key),
  setItem: (key, value) => storage.setItem(key, value),
  removeItem: (key) => storage.removeItem(key),
});

const message = (id) => ({ id, author: "me", text: id, time: "12:00" });
const messages = Array.from({ length: MAX_CACHED_MESSAGES_PER_CONVERSATION + 3 }, (_, index) => message(String(index)));
assert.equal(limitMessageList(messages).length, MAX_CACHED_MESSAGES_PER_CONVERSATION);
assert.equal(limitMessageList(messages)[0].id, "3");
assert.equal(sanitizeMessagesByProfile({ profile: { chat: messages, broken: [null, "bad"] } }).profile.chat.length, MAX_CACHED_MESSAGES_PER_CONVERSATION);

const entry = (id, attempts = 0) => ({ id, conversationId: "chat", message: message(id), attempts, nextAttemptAt: 0 });
const outbox = Array.from({ length: MAX_OUTBOX_ENTRIES + 3 }, (_, index) => entry(String(index)));
assert.equal(limitOutboxEntries(outbox).length, MAX_OUTBOX_ENTRIES);
assert.equal(limitOutboxEntries(outbox)[0].id, "3");
assert.equal(sanitizeOutboxByProfile({ profile: [...outbox, entry("dead", MAX_OUTBOX_ATTEMPTS)] }).profile.length, MAX_OUTBOX_ENTRIES);
assert.equal(retryDelay(MAX_OUTBOX_ATTEMPTS + 10), 60_000);

assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
assert.deepEqual(normalizeSettings(JSON.parse("{\"theme\":\"neon\",\"textSize\":\"large\",\"language\":\"en\",\"notifications\":{\"enabled\":\"yes\",\"preview\":false,\"sound\":true,\"unknown\":true},\"privacy\":{\"online\":false},\"cache\":{\"retentionDays\":999.4,\"autoloadMedia\":true},\"unknown\":true}")), {
  theme: "system",
  textSize: "large",
  language: "en",
  notifications: { enabled: true, preview: false, sound: true },
  cache: { retentionDays: 365, autoloadMedia: true },
});
assert.deepEqual(normalizeSettings({ cache: { retentionDays: -4.6 } }), { ...DEFAULT_SETTINGS, cache: { ...DEFAULT_SETTINGS.cache, retentionDays: 0 } });
assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
assert.equal(getSuggestedServerAddress("192.168.0.160"), "192.168.0.160:50121");
assert.equal(getSuggestedServerAddress("0.0.0.0"), "");

await storage.setItem(SETTINGS_STORAGE_KEY, "{not-json");
assert.deepEqual(await readSettings(), DEFAULT_SETTINGS);

const requestedSettings = {
  theme: "dark",
  textSize: "small",
  language: "system",
  notifications: { enabled: false, preview: false, sound: true },
  cache: { retentionDays: 7, autoloadMedia: true },
  ...Object.fromEntries(SENSITIVE_E2E_KEY_NAMES.map((name) => [name, "must-not-be-persisted"])),
};
const writtenSettings = await writeSettings(requestedSettings);
const persistedSettings = await readSettings();
assert.deepEqual(persistedSettings, {
  theme: "dark",
  textSize: "small",
  language: "system",
  notifications: { enabled: false, preview: false, sound: true },
  cache: { retentionDays: 7, autoloadMedia: true },
});
assert.deepEqual(writtenSettings, persistedSettings);
assert.deepEqual(JSON.parse(await storage.getItem(SETTINGS_STORAGE_KEY)), persistedSettings);
assert.ok(SENSITIVE_E2E_KEY_NAMES.every((name) => !JSON.stringify(persistedSettings).includes(name)));
assert.ok(!["enter-native-device-", "enter-fallback-device-", "enter-native-account-", "enter-fallback-account-"].some((prefix) => SETTINGS_STORAGE_KEY.startsWith(prefix)));

console.log("Mobile state limits and typed local settings self-check passed");
