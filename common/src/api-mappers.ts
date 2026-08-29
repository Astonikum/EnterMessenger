import { formatMessageTime } from "./format.ts";
import type { RemoteConversation, RemoteMessage } from "./api-types.ts";
import type { Conversation, Message } from "./types.ts";

export function mapRemoteConversation(remote: RemoteConversation): Conversation {
  return {
    id: remote.id,
    serverId: remote.serverId,
    name: remote.name,
    handle: remote.handle ?? undefined,
    avatar: remote.avatar,
    subtitle: remote.subtitle ?? undefined,
    canWrite: remote.canWrite,
    lastMessage: remote.lastMessage,
    time: remote.lastMessageAt ? formatMessageTime(new Date(remote.lastMessageAt)) : "",
    pinned: remote.pinned,
    online: remote.online,
    lastSeenAt: remote.lastSeenAt ?? undefined,
    unread: remote.unread ?? 0,
  };
}

export function mapRemoteMessage(remote: RemoteMessage): Message {
  return {
    id: remote.encryptedMessage.message_id,
    author: remote.author,
    text: "",
    time: formatMessageTime(new Date(remote.createdAt)),
    stackId: remote.stackId,
    encryptedMessage: remote.encryptedMessage,
  };
}
