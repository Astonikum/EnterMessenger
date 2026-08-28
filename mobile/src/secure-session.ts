import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

const SESSION_KEY_PREFIX = "enter-session-";
const FALLBACK_SESSION_KEY_PREFIX = "enter-session-fallback-";

function key(profileId: string) {
  return `${SESSION_KEY_PREFIX}${profileId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

function fallbackKey(profileId: string) {
  return `${FALLBACK_SESSION_KEY_PREFIX}${profileId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

async function available() {
  try { return await SecureStore.isAvailableAsync(); } catch { return false; }
}

export async function readSessionToken(profileId: string) {
  if (await available()) {
    try { return (await SecureStore.getItemAsync(key(profileId))) || undefined; } catch { return undefined; }
  }
  try { return (await AsyncStorage.getItem(fallbackKey(profileId))) || undefined; } catch { return undefined; }
}

export async function writeSessionToken(profileId: string, token: string) {
  if (await available()) {
    await SecureStore.setItemAsync(key(profileId), token);
    await AsyncStorage.removeItem(fallbackKey(profileId)).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(fallbackKey(profileId), token);
}

export async function deleteSessionToken(profileId: string) {
  if (await available()) {
    try { await SecureStore.deleteItemAsync(key(profileId)); } catch { /* Session cleanup is best effort. */ }
  }
  try { await AsyncStorage.removeItem(fallbackKey(profileId)); } catch { /* Session cleanup is best effort. */ }
}
