import notifee, { AndroidImportance, AuthorizationStatus } from "@notifee/react-native";
import { Platform } from "react-native";
import { readSettings } from "./settings";

const MESSAGE_CHANNEL_ID = "messages";
let notificationSetup: Promise<boolean> | null = null;

export function configureNotifications(): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(false);
  if (notificationSetup) return notificationSetup;
  notificationSetup = (async () => {
    try {
      const permission = await notifee.requestPermission();
      if (permission.authorizationStatus === AuthorizationStatus.DENIED) return false;
      if (Platform.OS === "android") {
        await notifee.createChannel({
          id: MESSAGE_CHANNEL_ID,
          name: "Сообщения",
          importance: AndroidImportance.HIGH,
          vibration: true,
          vibrationPattern: [0, 250, 250, 250],
          sound: "default",
        });
      }
      return true;
    } catch {
      return false;
    }
  })();
  return notificationSetup;
}

export async function registerForPushNotifications() {
  await configureNotifications();
  return null;
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
    await configureNotifications();
    await notifee.displayNotification({
      id: input.messageId,
      title: input.title,
      body: settings.notifications.preview && settings.notifications.inAppPreview ? input.text : "Новое сообщение",
      data: { local: "true", sound: settings.notifications.sound ? "true" : "false", profileId: input.profileId, conversationId: input.conversationId, messageId: input.messageId },
      android: {
        channelId: MESSAGE_CHANNEL_ID,
        pressAction: { id: "open-chat" },
        sound: settings.notifications.sound && settings.notifications.inAppSound ? "default" : undefined,
      },
      ios: { sound: settings.notifications.sound && settings.notifications.inAppSound ? "default" : undefined },
    });
  } catch {
    // Ignore unavailable notification providers; realtime delivery still works.
  }
}
