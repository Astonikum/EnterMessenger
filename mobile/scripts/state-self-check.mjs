import assert from "node:assert/strict";
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

console.log("Mobile state limits self-check passed");
