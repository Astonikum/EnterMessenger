import AsyncStorage from "@react-native-async-storage/async-storage";

export const SETTINGS_STORAGE_KEY = "enter-mobile-settings";

export type ThemePreference = "system" | "light" | "dark";
export type FontScale = 0.9 | 1 | 1.1;
export type DensityPreference = "comfortable" | "compact";
export type AccentPreference = "violet" | "blue" | "green" | "rose";
export type LocalePreference = "ru" | "en";
export type CachePolicy = "standard" | "minimal" | "disabled";

export type MobileSettings = {
  theme: ThemePreference;
  fontScale: FontScale;
  density: DensityPreference;
  accent: AccentPreference;
  locale: LocalePreference;
  notifications: {
    desktop: boolean;
    preview: boolean;
    sound: boolean;
  };
  cachePolicy: CachePolicy;
};

export const DEFAULT_SETTINGS: MobileSettings = {
  theme: "system",
  fontScale: 1,
  density: "comfortable",
  accent: "violet",
  locale: "ru",
  notifications: { desktop: true, preview: true, sound: false },
  cachePolicy: "standard",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function copyDefaults(): MobileSettings {
  return {
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications },
  };
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

export function normalizeSettings(value: unknown): MobileSettings {
  const input = isRecord(value) ? value : {};
  const notifications = isRecord(input.notifications) ? input.notifications : {};
  const defaults = copyDefaults();
  const legacyTextSize: FontScale = input.textSize === "small" ? 0.9 : input.textSize === "large" ? 1.1 : 1;
  const legacyLanguage: LocalePreference = input.language === "en" ? "en" : "ru";
  const legacyCache = isRecord(input.cache) ? input.cache : {};
  const legacyRetention = typeof legacyCache.retentionDays === "number" ? legacyCache.retentionDays : 30;

  return {
    theme: enumOr(input.theme, ["system", "light", "dark"], defaults.theme),
    fontScale: input.fontScale === 0.9 || input.fontScale === 1.1 ? input.fontScale : input.fontScale === 1 ? 1 : legacyTextSize,
    density: enumOr(input.density, ["comfortable", "compact"], defaults.density),
    accent: enumOr(input.accent, ["violet", "blue", "green", "rose"], defaults.accent),
    locale: enumOr(input.locale, ["ru", "en"], legacyLanguage),
    notifications: {
      desktop: booleanOr(notifications.desktop, booleanOr(notifications.enabled, defaults.notifications.desktop)),
      preview: booleanOr(notifications.preview, defaults.notifications.preview),
      sound: booleanOr(notifications.sound, defaults.notifications.sound),
    },
    cachePolicy: enumOr(input.cachePolicy, ["standard", "minimal", "disabled"], legacyRetention <= 0 ? "disabled" : legacyRetention <= 7 ? "minimal" : defaults.cachePolicy),
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
