export type ManagedDeviceResponse = {
  deviceId: string;
  platform: string;
  name?: string | null;
  appVersion?: string | null;
  createdAt: number;
  lastSeenAt?: number | null;
  current: boolean;
  revokedAt?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonNegativeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isManagedDeviceResponse(value: unknown): value is ManagedDeviceResponse {
  return isRecord(value)
    && hasOnlyKeys(value, ["deviceId", "platform", "name", "appVersion", "createdAt", "lastSeenAt", "current", "revokedAt"])
    && isString(value.deviceId, 256)
    && isString(value.platform, 64)
    && (value.name === undefined || value.name === null || isString(value.name, 256))
    && (value.appVersion === undefined || value.appVersion === null || isString(value.appVersion, 128))
    && isNonNegativeTimestamp(value.createdAt)
    && (value.lastSeenAt === undefined || value.lastSeenAt === null || isNonNegativeTimestamp(value.lastSeenAt))
    && typeof value.current === "boolean"
    && (value.revokedAt === undefined || value.revokedAt === null || isNonNegativeTimestamp(value.revokedAt));
}
