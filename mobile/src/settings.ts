import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_CLIENT_SETTINGS, copyDefaultClientSettings, normalizeClientSettings, type ClientSettings } from "../../common/src/settings.ts";

export const SETTINGS_STORAGE_KEY = "enter-mobile-settings";
export type { AccentPreference, CachePolicy, CallDataSaving, ChatListLayout, DebugSettings, DensityPreference, EnergySavingSettings, FontScale, LocalePreference, MediaAutoDownloadSettings, MediaSettings, NotificationSettings, ProxyProtocol, ProxySettings, SaveToGallerySettings, ThemePreference } from "../../common/src/settings.ts";
export type MobileSettings = ClientSettings;
export const DEFAULT_SETTINGS: MobileSettings = DEFAULT_CLIENT_SETTINGS;

export function normalizeSettings(value: unknown): MobileSettings {
  return normalizeClientSettings(value);
}

export async function readSettings(): Promise<MobileSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : undefined);
  } catch {
    return copyDefaultClientSettings();
  }
}

export async function writeSettings(value: MobileSettings): Promise<MobileSettings> {
  const settings = normalizeSettings(value);
  await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  return settings;
}

export async function resetSettings(): Promise<MobileSettings> {
  await AsyncStorage.removeItem(SETTINGS_STORAGE_KEY);
  return copyDefaultClientSettings();
}
