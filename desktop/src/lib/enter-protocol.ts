export const ENTER_PROTOCOL = "enter";
export const ENTER_PROTOCOL_VERSION = "enter/0.1";

export type EnterAddress = {
  handle: string;
  server: string;
};

export type EncryptedEnvelope = {
  protocol: typeof ENTER_PROTOCOL_VERSION;
  message_id: string;
  conversation_id: string;
  sender: string;
  recipient: string;
  sender_device: string;
  key_id: string;
  created_at: string;
  nonce: string;
  ephemeral_public_key: string;
  ciphertext: string;
  associated_data: string;
  signature: string;
};

export function parseEnterAddress(raw: string, fallbackServer?: string): EnterAddress | null {
  const value = raw.trim().replace(/^@/, "");
  if (!value) return null;

  const separator = value.lastIndexOf("@");
  if (separator === -1) {
    const server = normalizeServer(fallbackServer ?? "");
    return /^[a-z0-9._-]{1,64}$/.test(value) && server ? { handle: value.toLowerCase(), server } : null;
  }

  const handle = value.slice(0, separator).trim().toLowerCase();
  const server = normalizeServer(value.slice(separator + 1));
  if (!/^[a-z0-9._-]{1,64}$/.test(handle) || !server) return null;
  return { handle, server };
}

export function formatEnterAddress(address: EnterAddress) {
  return `${address.handle}@${address.server.replace(/^https?:\/\//, "")}`;
}

function normalizeServer(raw: string) {
  return normalizeServerAddress(raw);
}
import { normalizeServerAddress } from "./server-address";
