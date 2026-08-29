import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { readSettings } from "./settings";

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const isLocal = notification.request.content.data?.local === true;
    return { shouldShowAlert: isLocal, shouldPlaySound: isLocal && notification.request.content.data?.sound === true, shouldSetBadge: isLocal };
  },
});

let notificationSetup: Promise<boolean> | null = null;

export function configureNotifications(): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(false);
  if (notificationSetup) return notificationSetup;
  notificationSetup = (async () => {
    if (Platform.OS === "android") {
      try {
        await Notifications.setNotificationChannelAsync("messages", {
          name: "Сообщения",
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          sound: "default",
        });
      } catch {
        // A channel failure must not prevent permission/token setup.
      }
    }
    try {
      const permissions = await Notifications.getPermissionsAsync();
      if (permissions.status === "granted") return true;
      return (await Notifications.requestPermissionsAsync()).status === "granted";
    } catch {
      return false;
    }
  })();
  return notificationSetup;
}

export async function registerForPushNotifications() {
  if (Platform.OS === "web") return null;
  if (!(await configureNotifications())) return null;
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
    if (!settings.notifications.desktop || !settings.notifications.allAccounts || !settings.notifications.privateChats) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: input.title,
        body: settings.notifications.preview && settings.notifications.inAppPreview ? input.text : "Новое сообщение",
        sound: settings.notifications.sound && settings.notifications.inAppSound ? "default" : undefined,
        badge: settings.notifications.showCounter ? 1 : undefined,
        data: { local: true, sound: settings.notifications.sound, profileId: input.profileId, conversationId: input.conversationId, messageId: input.messageId },
      },
      trigger: Platform.OS === "android" ? { channelId: "messages", seconds: 1 } : null,
    });
  } catch {
    // Ignore unavailable notification providers; realtime delivery still works.
  }
}
