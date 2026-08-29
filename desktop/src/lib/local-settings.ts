import { DEFAULT_CLIENT_SETTINGS, normalizeClientSettings, type AccentPreference, type ClientSettings, type ThemePreference } from "../../../common/src/settings.ts";

export type { AccentPreference, CachePolicy, CallDataSaving, ChatListLayout, DebugSettings, DensityPreference, EnergySavingSettings, FontScale, LocalePreference, MediaAutoDownloadSettings, MediaSettings, NotificationSettings, ProxyProtocol, ProxySettings, SaveToGallerySettings, ThemePreference } from "../../../common/src/settings.ts";
export type LocalClientSettings = ClientSettings;
export const DEFAULT_LOCAL_SETTINGS: LocalClientSettings = DEFAULT_CLIENT_SETTINGS;

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
  return normalizeClientSettings({ ...stored, notifications: notifications ?? stored.notifications });
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
  root.dataset.commonDebug = settings.debug.showCommonElements ? "true" : "false";
  root.lang = settings.locale;
  root.style.setProperty("--font-scale", String(settings.fontScale));
  root.style.setProperty("--message-font-size", `${settings.messageTextSize}px`);
  root.style.setProperty("--bubble-radius", `${settings.bubbleRadius}px`);
  root.style.setProperty("--primary", accent.primary);
  root.style.setProperty("--primary-foreground", accent.foreground);
  root.style.setProperty("--accent", accent.accent);
  root.style.setProperty("--ring", accent.ring);
}
