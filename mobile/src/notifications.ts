import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export type NotificationSettings = {
  desktop: boolean;
  sound: boolean;
  preview: boolean;
};

const SETTINGS_KEY = "enter-notification-settings";
const DEFAULT_SETTINGS: NotificationSettings = { desktop: true, sound: false, preview: true };

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const isLocal = notification.request.content.data?.local === true;
    const settings = isLocal ? await readNotificationSettings() : DEFAULT_SETTINGS;
    return {
      shouldShowAlert: isLocal,
      shouldPlaySound: isLocal && settings.sound,
      shouldSetBadge: isLocal,
    };
  },
});

export async function configureNotifications() {
  if (Platform.OS === "web") return;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("messages", {
        name: "Сообщения",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        sound: "default",
      });
    }
    const permissions = await Notifications.getPermissionsAsync();
    if (permissions.status !== "granted") await Notifications.requestPermissionsAsync();
  } catch {
    // Notification support is optional in Expo web and preview runtimes.
  }
}

export async function readNotificationSettings(): Promise<NotificationSettings> {
  try {
    const value = JSON.parse((await AsyncStorage.getItem(SETTINGS_KEY)) ?? "null") as Partial<NotificationSettings> | null;
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
  return AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function registerForPushNotifications() {
  if (Platform.OS === "web") return null;
  const permissions = await Notifications.getPermissionsAsync();
  if (permissions.status !== "granted") return null;
  try {
    return (await Notifications.getExpoPushTokenAsync()).data;
  } catch {
    return null;
  }
}

export async function notifyIncomingMessage(input: {
  profileId: string;
  conversationId: string;
  messageId: string;
  title: string;
  text: string;
}) {
  const settings = await readNotificationSettings();
  if (!settings.desktop) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: input.title,
        body: settings.preview ? input.text : "Новое сообщение",
        sound: settings.sound ? "default" : undefined,
        data: { local: true, profileId: input.profileId, conversationId: input.conversationId, messageId: input.messageId },
      },
      trigger: Platform.OS === "android" ? { channelId: "messages", seconds: 1 } : null,
    });
  } catch {
    // Ignore unavailable notification providers; realtime delivery still works.
  }
}
