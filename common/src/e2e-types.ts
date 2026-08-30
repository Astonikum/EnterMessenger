export type DeviceKeyBundle = {
  deviceId: string;
  keyId: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  createdAt: number;
};

export type PublicDeviceKey = DeviceKeyBundle & { address: string; serverId?: string };
export type PublicAccountKey = { keyId: string; encryptionPublicKey: string; address: string; serverId?: string };
export type PublicEncryptionKey = Pick<PublicDeviceKey, "keyId" | "encryptionPublicKey" | "address">;
