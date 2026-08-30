import assert from "node:assert/strict";
import test from "node:test";
import { clearConversationUnread, compactText, filterConversations, incrementConversationUnread } from "../common/src/conversations.ts";
import { decodeMessagePayload, encodeMessagePayload } from "../common/src/message-payload.ts";
import { isChatFolder, normalizeFolder } from "../common/src/folders.ts";
import { isAccountSettings, isRealtimeEvent } from "../common/src/api-contract.ts";
import { formatEnterAddress, parseEnterAddress } from "../common/src/address.ts";
import { isAuthDraftValid, isAuthHealthResponse, isAuthResponse } from "../common/src/auth.ts";
import { messagePreview } from "../common/src/messages.ts";
import { normalizeClientSettings } from "../common/src/settings.ts";
import { limitMessagesByTotal, sanitizeOutboxByProfile } from "../common/src/storage-models.ts";
import { mapRemoteConversation, mapRemoteMessage } from "../common/src/api-mappers.ts";
import { applyBeforeAcknowledge, mergeRemoteMessages, reconcileRemoteMessages } from "../common/src/message-state.ts";
import { createBackActionRegistry } from "../common/src/navigation.ts";
import { createPresenceLifecycle } from "../common/src/presence-lifecycle.ts";
import { createPresenceStateMachine, derivePresenceState, shouldKeepPresenceConnection } from "../common/src/presence.ts";
import { consumeMessageStateApplied, markMessageStateApplied, timingElapsed } from "../common/src/timing.ts";

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
  assert.deepEqual(decodeMessagePayload('ENTER_MESSAGE_V2:{"text":"legacy","attachments":[]}'), { text: "legacy", editOf: undefined, attachments: [] });
});

test("common realtime applies a message before best-effort acknowledgement", async () => {
  let releaseAcknowledgement;
  const acknowledgementReleased = new Promise((resolve) => { releaseAcknowledgement = resolve; });
  let acknowledgementStarted;
  const acknowledgementStartedPromise = new Promise((resolve) => { acknowledgementStarted = resolve; });
  let acknowledgementFinished = false;

  const result = await applyBeforeAcknowledge(
    () => "visible",
    async () => {
      acknowledgementStarted();
      await acknowledgementReleased;
      acknowledgementFinished = true;
    },
  );

  assert.equal(result, "visible");
  assert.equal(acknowledgementFinished, false);
  await acknowledgementStartedPromise;
  releaseAcknowledgement();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledgementFinished, true);

  let acknowledgementError;
  const failedResult = await applyBeforeAcknowledge(
    () => "still-visible",
    async () => { throw new Error("offline"); },
    (reason) => { acknowledgementError = reason; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failedResult, "still-visible");
  assert.equal(acknowledgementError?.message, "offline");
});

test("common realtime reconciliation deduplicates repeated message events", () => {
  const message = { id: "message-1", author: "them", text: "hello", time: "12:00" };
  const next = reconcileRemoteMessages({}, [
    { conversationId: "chat-1", message },
    { conversationId: "chat-1", message: { ...message } },
  ]);

  assert.deepEqual(next["chat-1"].map(({ id }) => id), ["message-1"]);
});

test("common optimistic message survives realtime echo without losing reply metadata", () => {
  const replyTo = { id: "message-0", text: "question" };
  const pending = { id: "message-1", author: "me", text: "answer", time: "12:00", replyTo, deliveryStatus: "pending" };
  const local = mergeRemoteMessages({}, [{ conversationId: "chat-1", message: pending }]);
  const echoed = mergeRemoteMessages(local, [{ conversationId: "chat-1", message: { id: pending.id, author: pending.author, text: pending.text, time: pending.time, replyTo } }]);

  assert.equal(echoed["chat-1"].length, 1);
  assert.deepEqual(echoed["chat-1"][0].replyTo, replyTo);
});

test("common timing marks report state-to-render separately", () => {
  const startedAt = 10;
  assert.equal(timingElapsed(startedAt, 25), 15);
  markMessageStateApplied("timing-message", startedAt, "realtime");
  assert.deepEqual(consumeMessageStateApplied("timing-message"), { at: startedAt, source: "realtime" });
  assert.equal(consumeMessageStateApplied("timing-message"), undefined);
});

test("common presence stays online only for a focused foreground connection", () => {
  const base = { appActive: true, visible: true, focused: true, networkOnline: true, realtimeReady: true, lastHeartbeatAt: 1_000 };
  assert.equal(derivePresenceState(base, 2_000), "online");
  assert.equal(derivePresenceState({ ...base, focused: false }, 2_000), "background");
  assert.equal(derivePresenceState({ ...base, visible: false }, 2_000), "background");
  assert.equal(derivePresenceState({ ...base, networkOnline: false }, 2_000), "offline");
  assert.equal(derivePresenceState({ ...base, realtimeReady: false }, 2_000), "connecting");
  assert.equal(derivePresenceState(base, 50_001), "stale");
  assert.equal(shouldKeepPresenceConnection(base), true);
  assert.equal(shouldKeepPresenceConnection({ ...base, focused: false }), false);

  const machine = createPresenceStateMachine({ ...base, realtimeReady: false, lastHeartbeatAt: null });
  assert.equal(machine.getState(), "connecting");
  assert.equal(machine.update({ visible: false }).current, "background");
  assert.equal(machine.update({ visible: true, realtimeReady: true, lastHeartbeatAt: 3_000 }, 3_001).current, "online");
});

test("common message payload round-trips replies and reaction events", () => {
  const reply = { id: "message-0", text: "original" };
  const message = { id: "message-1", author: "me", text: "answer", time: "12:00", replyTo: reply };
  assert.deepEqual(decodeMessagePayload(encodeMessagePayload(message)), { text: "answer", editOf: undefined, attachments: [], replyTo: reply });

  const reaction = { id: "reaction-1", author: "me", text: "", time: "12:01", reactionEvent: { targetMessageId: "message-1", reaction: "❤️" } };
  assert.deepEqual(decodeMessagePayload(encodeMessagePayload(reaction)), { text: "", reactionEvent: reaction.reactionEvent });
  const removal = { ...reaction, reactionEvent: { targetMessageId: "message-1", reaction: null } };
  assert.deepEqual(decodeMessagePayload(encodeMessagePayload(removal)), { text: "", reactionEvent: removal.reactionEvent });
});

test("common message state merges reaction add, replace and remove events", () => {
  const target = { id: "message-1", author: "them", text: "hello", time: "12:00" };
  const event = (reaction, id) => ({ id, author: "them", text: "", time: "12:01", reactionEvent: { targetMessageId: target.id, reaction } });

  let state = mergeRemoteMessages({ chat: [target] }, [{ conversationId: "chat", message: event("❤️", "reaction-1") }]);
  assert.equal(state.chat[0].reaction, "❤️");
  state = mergeRemoteMessages(state, [{ conversationId: "chat", message: event("🔥", "reaction-2") }]);
  assert.equal(state.chat[0].reaction, "🔥");
  state = mergeRemoteMessages(state, [{ conversationId: "chat", message: event(null, "reaction-3") }]);
  assert.equal(state.chat[0].reaction, undefined);
  assert.deepEqual(state.chat.map(({ id }) => id), [target.id]);
});

test("common navigation handles registered panels in reverse order", () => {
  const registry = createBackActionRegistry();
  const handled = [];
  const removeRoot = registry.register(() => { handled.push("root"); return true; });
  const removeNested = registry.register(() => { handled.push("nested"); return true; });

  assert.equal(registry.handle(), true);
  assert.deepEqual(handled, ["nested"]);
  removeNested();
  assert.equal(registry.handle(), true);
  assert.deepEqual(handled, ["nested", "root"]);
  removeRoot();
  assert.equal(registry.handle(), false);
});

test("common unread state stays clear for an active conversation without re-entering", () => {
  const conversations = [
    { id: "chat", name: "Chat", avatar: "", lastMessage: "", time: "", unread: 3 },
    { id: "other", name: "Other", avatar: "", lastMessage: "", time: "", unread: 0 },
  ];
  const opened = clearConversationUnread(conversations, "chat");

  assert.equal(opened[0].unread, 0);
  assert.equal(incrementConversationUnread(opened, "chat", "chat")[0].unread, 0);
  assert.equal(incrementConversationUnread(opened, "chat", "chat")[0].unread, 0);
  assert.equal(incrementConversationUnread(opened, "other", "chat")[1].unread, 1);
  assert.equal(clearConversationUnread(conversations, "chat", false)[0].unread, 3);
  assert.equal(incrementConversationUnread(opened, "chat", "chat", false)[0].unread, 1);
});

test("common presence lifecycle only activates while foregrounded", () => {
  const calls = [];
  const lifecycle = createPresenceLifecycle(false, {
    onForeground: () => calls.push("foreground"),
    onBackground: () => calls.push("background"),
  });

  lifecycle.start();
  assert.deepEqual(calls, []);
  lifecycle.setForeground(true);
  lifecycle.setForeground(false);
  lifecycle.stop();
  lifecycle.setForeground(true);
  assert.deepEqual(calls, ["foreground", "background", "background"]);
  assert.equal(lifecycle.isForeground(), false);
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

test("common auth models validate form and response boundaries", () => {
  assert.ok(isAuthDraftValid({ mode: "login", name: "", handle: " alex ", password: "password" }));
  assert.ok(!isAuthDraftValid({ mode: "register", name: "", handle: "alex", password: "password" }));
  assert.ok(isAuthHealthResponse({ status: "ok", protocol: "enter/0.2", serverId: "server-1", logo: null }));
  assert.ok(!isAuthHealthResponse({ status: "ok", protocol: "enter/0.2", logo: null }));
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
