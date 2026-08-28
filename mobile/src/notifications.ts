import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { readSettings } from "./settings";

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const isLocal = notification.request.content.data?.local === true;
    return { shouldShowAlert: isLocal, shouldPlaySound: isLocal && notification.request.content.data?.sound === true, shouldSetBadge: isLocal };
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
  try {
    const settings = await readSettings();
    if (!settings.notifications.enabled) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: input.title,
        body: settings.notifications.preview ? input.text : "Новое сообщение",
        sound: settings.notifications.sound ? "default" : undefined,
        data: { local: true, sound: settings.notifications.sound, profileId: input.profileId, conversationId: input.conversationId, messageId: input.messageId },
      },
      trigger: Platform.OS === "android" ? { channelId: "messages", seconds: 1 } : null,
    });
  } catch {
    // Ignore unavailable notification providers; realtime delivery still works.
  }
}
