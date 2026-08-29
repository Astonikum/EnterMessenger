export const ENTER_PROTOCOL_VERSION = "enter/0.2" as const;

export type EncryptedMessage = {
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
