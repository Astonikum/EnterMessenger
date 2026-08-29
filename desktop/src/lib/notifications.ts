import { readLocalSettings, writeLocalSettings, type NotificationSettings } from "./local-settings";
import { isTauri } from "@tauri-apps/api/core";

export type { NotificationSettings } from "./local-settings";

export function readNotificationSettings(): NotificationSettings {
  return readLocalSettings().notifications;
}

export function writeNotificationSettings(settings: NotificationSettings) {
  writeLocalSettings({ ...readLocalSettings(), notifications: settings });
}

export async function requestDesktopNotificationPermission() {
  if (isTauri()) {
    try {
      const plugin = await import("@tauri-apps/plugin-notification");
      if (await plugin.isPermissionGranted()) return true;
      return (await plugin.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  try {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function showDesktopWindow() {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.show();
    await window.unminimize();
    await window.setFocus();
  } catch {
    // The notification action can still select the conversation if focus fails.
  }
}

export async function notifyIncomingMessage(input: {
  profileId: string;
  conversationId: string;
  title: string;
  text: string;
}) {
  const settings = readNotificationSettings();
  if (!settings.desktop || !settings.allAccounts || !settings.privateChats) return;
  if (!(await requestDesktopNotificationPermission())) return;
  const body = settings.preview && settings.inAppPreview ? input.text : "Новое сообщение";

  if (isTauri()) {
    try {
      const plugin = await import("@tauri-apps/plugin-notification");
      plugin.sendNotification({
        title: input.title,
        body,
        sound: settings.sound && settings.inAppSound ? "Ping" : undefined,
        extra: { profileId: input.profileId, conversationId: input.conversationId },
      });
      return;
    } catch {
      // Browser fallback keeps the Vite preview usable outside Tauri.
    }
  }

  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const notification = new Notification(input.title, { body });
  notification.onclick = () => {
    window.focus();
    window.dispatchEvent(new CustomEvent("enter:open-conversation", {
      detail: { profileId: input.profileId, conversationId: input.conversationId },
    }));
  };
}

export async function subscribeToNotificationActions(onOpen: (profileId: string, conversationId: string) => void) {
  if (!isTauri()) return () => undefined;
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    const listener = await plugin.onAction((notification) => {
      const profileId = typeof notification.extra?.profileId === "string" ? notification.extra.profileId : null;
      const conversationId = typeof notification.extra?.conversationId === "string" ? notification.extra.conversationId : null;
      if (profileId && conversationId) {
        void showDesktopWindow();
        onOpen(profileId, conversationId);
      }
    });
    return () => { void listener.unregister(); };
  } catch {
    return () => undefined;
  }
}
