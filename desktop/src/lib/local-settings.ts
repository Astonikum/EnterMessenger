export type ThemePreference = "system" | "light" | "dark";
export type FontScale = 0.9 | 1 | 1.1;
export type DensityPreference = "comfortable" | "compact";
export type AccentPreference = "violet" | "blue" | "green" | "rose";
export type LocalePreference = "ru" | "en";
export type CachePolicy = "standard" | "minimal" | "disabled";

export type NotificationSettings = {
  desktop: boolean;
  sound: boolean;
  preview: boolean;
};

export type LocalClientSettings = {
  theme: ThemePreference;
  fontScale: FontScale;
  density: DensityPreference;
  accent: AccentPreference;
  locale: LocalePreference;
  notifications: NotificationSettings;
  cachePolicy: CachePolicy;
};

export const DEFAULT_LOCAL_SETTINGS: LocalClientSettings = {
  theme: "system",
  fontScale: 1,
  density: "comfortable",
  accent: "violet",
  locale: "ru",
  notifications: { desktop: true, sound: false, preview: true },
  cachePolicy: "standard",
};

const SETTINGS_KEY = "enter-local-settings";
const LEGACY_NOTIFICATION_KEY = "enter-notification-settings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(key: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function readLocalSettings(): LocalClientSettings {
  const stored = readJson(SETTINGS_KEY) ?? {};
  const legacyNotifications = readJson(LEGACY_NOTIFICATION_KEY);
  const notifications = isRecord(stored.notifications) ? stored.notifications : legacyNotifications;
  return {
    theme: stored.theme === "light" || stored.theme === "dark" ? stored.theme : DEFAULT_LOCAL_SETTINGS.theme,
    fontScale: stored.fontScale === 0.9 || stored.fontScale === 1.1 ? stored.fontScale : DEFAULT_LOCAL_SETTINGS.fontScale,
    density: stored.density === "compact" ? stored.density : DEFAULT_LOCAL_SETTINGS.density,
    accent: stored.accent === "blue" || stored.accent === "green" || stored.accent === "rose" ? stored.accent : DEFAULT_LOCAL_SETTINGS.accent,
    locale: stored.locale === "en" ? stored.locale : DEFAULT_LOCAL_SETTINGS.locale,
    notifications: {
      desktop: typeof notifications?.desktop === "boolean" ? notifications.desktop : DEFAULT_LOCAL_SETTINGS.notifications.desktop,
      sound: typeof notifications?.sound === "boolean" ? notifications.sound : DEFAULT_LOCAL_SETTINGS.notifications.sound,
      preview: typeof notifications?.preview === "boolean" ? notifications.preview : DEFAULT_LOCAL_SETTINGS.notifications.preview,
    },
    cachePolicy: stored.cachePolicy === "minimal" || stored.cachePolicy === "disabled" ? stored.cachePolicy : DEFAULT_LOCAL_SETTINGS.cachePolicy,
  };
}

export function writeLocalSettings(settings: LocalClientSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Local preferences must never block the messenger.
  }
}

function resolvedTheme(theme: ThemePreference) {
  if (theme !== "system") return theme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const accents: Record<AccentPreference, { primary: string; foreground: string; accent: string; ring: string }> = {
  violet: { primary: "247 94% 78%", foreground: "0 0% 8%", accent: "248 52% 31%", ring: "247 94% 78%" },
  blue: { primary: "211 96% 68%", foreground: "0 0% 8%", accent: "214 55% 30%", ring: "211 96% 68%" },
  green: { primary: "153 64% 63%", foreground: "0 0% 8%", accent: "154 45% 28%", ring: "153 64% 63%" },
  rose: { primary: "340 88% 74%", foreground: "0 0% 8%", accent: "338 48% 31%", ring: "340 88% 74%" },
};

export function applyLocalSettings(settings: LocalClientSettings) {
  const root = document.documentElement;
  const accent = accents[settings.accent];
  root.dataset.theme = resolvedTheme(settings.theme);
  root.dataset.density = settings.density;
  root.lang = settings.locale;
  root.style.setProperty("--font-scale", String(settings.fontScale));
  root.style.setProperty("--primary", accent.primary);
  root.style.setProperty("--primary-foreground", accent.foreground);
  root.style.setProperty("--accent", accent.accent);
  root.style.setProperty("--ring", accent.ring);
}
