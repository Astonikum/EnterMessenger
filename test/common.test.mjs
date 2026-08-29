import assert from "node:assert/strict";
import test from "node:test";
import { compactText, filterConversations } from "../common/src/conversations.ts";
import { decodeMessagePayload, encodeMessagePayload } from "../common/src/message-payload.ts";
import { isChatFolder, normalizeFolder } from "../common/src/folders.ts";
import { isAccountSettings, isRealtimeEvent } from "../common/src/api-contract.ts";
import { formatEnterAddress, parseEnterAddress } from "../common/src/address.ts";
import { isAuthDraftValid, isAuthHealthResponse, isAuthResponse } from "../common/src/auth.ts";
import { messagePreview } from "../common/src/messages.ts";
import { normalizeClientSettings } from "../common/src/settings.ts";
import { sameServerAddress } from "../common/src/server-address.ts";
import { limitMessagesByTotal, sanitizeOutboxByProfile } from "../common/src/storage-models.ts";
import { mapRemoteConversation, mapRemoteMessage } from "../common/src/api-mappers.ts";

test("common message payload round-trips edits and attachments", () => {
  const message = {
    id: "message-1",
    author: "me",
    text: "hello",
    time: "12:00",
    editOf: "message-0",
    attachments: [{ id: "file-1", kind: "file", name: "a.txt", mimeType: "text/plain", size: 3, sha256: "hash", key: "key", nonce: "nonce" }],
  };

  assert.deepEqual(decodeMessagePayload(encodeMessagePayload(message)), {
    text: "hello",
    editOf: "message-0",
    attachments: message.attachments,
  });
  assert.deepEqual(decodeMessagePayload("plain text"), { text: "plain text" });
});

test("common folder and conversation rules stay deterministic", () => {
  const folder = normalizeFolder({ id: "work", name: "  Работа  ", template: "custom", icon: "folder", chatIds: ["b"] });
  assert.ok(folder);
  assert.equal(folder.name, "Работа");
  assert.ok(isChatFolder(folder));

  const conversations = [
    { id: "a", name: "A", avatar: "a", lastMessage: "first", time: "", pinned: false },
    { id: "b", name: "B", avatar: "b", lastMessage: "second", time: "", pinned: true },
    { id: "c", name: "C", avatar: "c", lastMessage: "hidden", time: "", archived: true },
  ];
  assert.deepEqual(filterConversations(conversations, [folder], "all", "").map(({ id }) => id), ["b", "a"]);
  assert.deepEqual(filterConversations(conversations, [folder], "work", "").map(({ id }) => id), ["b"]);
  assert.equal(compactText("  one\n two  ", 7), "one two");
});

test("common API contracts validate shared server responses", () => {
  assert.ok(isRealtimeEvent({ type: "ready", version: 1 }));
  assert.ok(!isRealtimeEvent({ type: "ready", version: "1" }));
  assert.ok(isAccountSettings({
    id: "account-1",
    name: "Alex",
    handle: "alex",
    showOnline: true,
    showLastSeen: true,
    readReceipts: true,
    typingIndicators: true,
    showPhone: false,
    showProfilePhoto: true,
    allowForwarding: true,
    allowCalls: true,
    suggestPeople: true,
  }));
});

test("common Enter address grammar delegates server normalization", () => {
  const normalize = (value) => value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "") ? `https://${value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")}` : null;
  const address = parseEnterAddress("@Alex@example.test/", "server.test", normalize);
  assert.deepEqual(address, { handle: "alex", server: "https://example.test" });
  assert.equal(formatEnterAddress(address), "alex@example.test");
});

test("common server addresses accept only equivalent local aliases", () => {
  assert.ok(sameServerAddress("http://localhost:50121", "http://127.0.0.1:50121"));
  assert.ok(sameServerAddress("http://0.0.0.0:50121", "http://[::1]:50121"));
  assert.ok(!sameServerAddress("http://localhost:50121", "https://127.0.0.1:50121"));
  assert.ok(!sameServerAddress("http://localhost:50121", "http://127.0.0.1:50122"));
  assert.ok(!sameServerAddress("http://10.0.0.2:50121", "http://192.168.1.2:50121"));
});

test("common auth models validate form and response boundaries", () => {
  assert.ok(isAuthDraftValid({ mode: "login", name: "", handle: " alex ", password: "password" }));
  assert.ok(!isAuthDraftValid({ mode: "register", name: "", handle: "alex", password: "password" }));
  assert.ok(isAuthHealthResponse({ status: "ok", protocol: "enter/0.2", logo: null }));
  assert.ok(isAuthResponse({ token: "token", profile: { id: "1", name: "Alex", handle: "alex", serverId: "server" } }));
  assert.ok(!isAuthResponse({ token: "", profile: { id: "1", name: "Alex", handle: "alex", serverId: "server" } }));
});

test("common UI settings and storage models normalize shared state", () => {
  const settings = normalizeClientSettings({ debug: { showCommonElements: true }, media: { autoDownload: { videoLimitMb: 9999 } } });
  assert.equal(settings.debug.showCommonElements, true);
  assert.equal(settings.media.autoDownload.videoLimitMb, 500);

  const messages = [
    { id: "old", author: "them", text: "old", time: "10:00" },
    { id: "new", author: "them", text: "", time: "10:01", attachments: [{ id: "a", kind: "audio", name: "voice.ogg", mimeType: "audio/ogg", size: 1, sha256: "h", key: "k", nonce: "n" }] },
  ];
  assert.equal(messagePreview(messages[1]), "[Аудио]");
  assert.deepEqual(Object.keys(limitMessagesByTotal({ chat: messages }, { perConversation: 1, total: 1 })), ["chat"]);
  assert.equal(limitMessagesByTotal({ chat: messages }, { perConversation: 1, total: 1 }).chat[0].id, "new");

  const outbox = sanitizeOutboxByProfile({ profile: [{ id: "outbox", conversationId: "chat", message: messages[0], attempts: 1.8, nextAttemptAt: 1 }] }, 3, 10);
  assert.equal(outbox.profile[0].attempts, 1);
});

test("common API mappers keep remote and UI models aligned", () => {
  const encryptedMessage = {
    protocol: "enter/0.2",
    message_id: "message-1",
    conversation_id: "chat-1",
    sender: "alex@example.test",
    recipient: "sam@example.test",
    sender_device: "device-1",
    key_id: "key-1",
    created_at: "2026-01-01T00:00:00.000Z",
    nonce: "nonce",
    ephemeral_public_key: "public",
    ciphertext: "ciphertext",
    associated_data: "data",
    signature: "signature",
  };
  const remoteMessage = { id: "remote-1", conversationId: "chat-1", author: "them", createdAt: 1_700_000_000_000, stackId: "stack-1", encryptedMessage };
  assert.equal(mapRemoteMessage(remoteMessage).id, "message-1");
  assert.equal(mapRemoteMessage(remoteMessage).text, "");
  assert.equal(mapRemoteConversation({ id: "chat-1", name: "Chat", avatar: "avatar", lastMessage: "Hi", canWrite: true, pinned: false, online: true, unread: 2 }).unread, 2);
});
