import AsyncStorage from "@react-native-async-storage/async-storage";

export const SETTINGS_STORAGE_KEY = "enter-mobile-settings";

export type ThemePreference = "system" | "light" | "dark";
export type TextSize = "small" | "medium" | "large";
export type AppLanguage = "system" | "ru" | "en";

export type MobileSettings = {
  theme: ThemePreference;
  textSize: TextSize;
  language: AppLanguage;
  notifications: {
    enabled: boolean;
    preview: boolean;
    sound: boolean;
  };
  cache: {
    retentionDays: number;
    autoloadMedia: boolean;
  };
};

export const DEFAULT_SETTINGS: MobileSettings = {
  theme: "system",
  textSize: "medium",
  language: "ru",
  notifications: { enabled: true, preview: false, sound: false },
  cache: { retentionDays: 30, autoloadMedia: false },
};

const RETENTION_MIN_DAYS = 0;
const RETENTION_MAX_DAYS = 365;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function copyDefaults(): MobileSettings {
  return {
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications },
    cache: { ...DEFAULT_SETTINGS.cache },
  };
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function retentionOr(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, Math.round(value)));
}

export function normalizeSettings(value: unknown): MobileSettings {
  const input = isRecord(value) ? value : {};
  const notifications = isRecord(input.notifications) ? input.notifications : {};
  const cache = isRecord(input.cache) ? input.cache : {};
  const defaults = copyDefaults();

  return {
    theme: enumOr(input.theme, ["system", "light", "dark"], defaults.theme),
    textSize: enumOr(input.textSize, ["small", "medium", "large"], defaults.textSize),
    language: enumOr(input.language, ["system", "ru", "en"], defaults.language),
    notifications: {
      enabled: booleanOr(notifications.enabled, defaults.notifications.enabled),
      preview: booleanOr(notifications.preview, defaults.notifications.preview),
      sound: booleanOr(notifications.sound, defaults.notifications.sound),
    },
    cache: {
      retentionDays: retentionOr(cache.retentionDays, defaults.cache.retentionDays),
      autoloadMedia: booleanOr(cache.autoloadMedia, defaults.cache.autoloadMedia),
    },
  };
}

export async function readSettings(): Promise<MobileSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : undefined);
  } catch {
    return copyDefaults();
  }
}

export async function writeSettings(value: MobileSettings): Promise<MobileSettings> {
  const settings = normalizeSettings(value);
  await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  return settings;
}

export async function resetSettings(): Promise<MobileSettings> {
  await AsyncStorage.removeItem(SETTINGS_STORAGE_KEY);
  return copyDefaults();
}
