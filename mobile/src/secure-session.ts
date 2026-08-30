import * as Keychain from "react-native-keychain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { withTimeout } from "./with-timeout";

const SESSION_KEY_PREFIX = "enter-session-";
const FALLBACK_SESSION_KEY_PREFIX = "enter-session-fallback-";

function key(profileId: string) {
  return `${SESSION_KEY_PREFIX}${profileId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

function fallbackKey(profileId: string) {
  return `${FALLBACK_SESSION_KEY_PREFIX}${profileId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

async function available() {
  if (Platform.OS === "web") return false;
  try { await withTimeout(Keychain.getGenericPassword({ service: "enter-availability-probe" }), "Время проверки безопасного хранилища истекло"); return true; } catch { return false; }
}

export async function readSessionToken(profileId: string) {
  if (await available()) {
    try {
      const credentials = await withTimeout(Keychain.getGenericPassword({ service: key(profileId) }), "Не удалось прочитать сессию");
      return credentials ? credentials.password : undefined;
    } catch { return undefined; }
  }
  try { return (await AsyncStorage.getItem(fallbackKey(profileId))) || undefined; } catch { return undefined; }
}

export async function writeSessionToken(profileId: string, token: string) {
  if (await available()) {
    await withTimeout(Keychain.setGenericPassword("enter", token, { service: key(profileId) }), "Не удалось сохранить сессию");
    await AsyncStorage.removeItem(fallbackKey(profileId)).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(fallbackKey(profileId), token);
}

export async function deleteSessionToken(profileId: string) {
  if (await available()) {
    try { await Keychain.resetGenericPassword({ service: key(profileId) }); } catch { /* Session cleanup is best effort. */ }
  }
  try { await AsyncStorage.removeItem(fallbackKey(profileId)); } catch { /* Session cleanup is best effort. */ }
}
