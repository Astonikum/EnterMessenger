export type NotificationSettings = {
  desktop: boolean;
  sound: boolean;
  preview: boolean;
};

const SETTINGS_KEY = "enter-notification-settings";
const DEFAULT_SETTINGS: NotificationSettings = { desktop: true, sound: false, preview: true };

export function readNotificationSettings(): NotificationSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<NotificationSettings> | null;
    return {
      desktop: value?.desktop ?? DEFAULT_SETTINGS.desktop,
      sound: value?.sound ?? DEFAULT_SETTINGS.sound,
      preview: value?.preview ?? DEFAULT_SETTINGS.preview,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeNotificationSettings(settings: NotificationSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function requestDesktopNotificationPermission() {
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    if (await plugin.isPermissionGranted()) return true;
    return (await plugin.requestPermission()) === "granted";
  } catch {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    return (await Notification.requestPermission()) === "granted";
  }
}

export async function notifyIncomingMessage(input: {
  profileId: string;
  conversationId: string;
  title: string;
  text: string;
}) {
  const settings = readNotificationSettings();
  if (!settings.desktop) return;
  if (!(await requestDesktopNotificationPermission())) return;
  const body = settings.preview ? input.text : "Новое сообщение";

  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    plugin.sendNotification({
      title: input.title,
      body,
      extra: { profileId: input.profileId, conversationId: input.conversationId },
    });
    return;
  } catch {
    // Browser fallback keeps the Vite preview usable outside Tauri.
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
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    const listener = await plugin.onAction((notification) => {
      const profileId = typeof notification.extra?.profileId === "string" ? notification.extra.profileId : null;
      const conversationId = typeof notification.extra?.conversationId === "string" ? notification.extra.conversationId : null;
      if (profileId && conversationId) onOpen(profileId, conversationId);
    });
    return () => { void listener.unregister(); };
  } catch {
    return () => undefined;
  }
}
