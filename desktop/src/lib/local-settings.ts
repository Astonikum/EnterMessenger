export type ThemePreference = "system" | "light" | "dark";
export type FontScale = 0.9 | 1 | 1.1;
export type DensityPreference = "comfortable" | "compact";
export type AccentPreference = "violet" | "blue" | "green" | "rose";
export type LocalePreference = "ru" | "en";
export type CachePolicy = "standard" | "minimal" | "disabled";
export type ChatListLayout = "two-line" | "three-line";
export type ProxyProtocol = "http" | "socks5";
export type CallDataSaving = "never" | "roaming" | "always";

export type NotificationSettings = {
  desktop: boolean;
  sound: boolean;
  preview: boolean;
  allAccounts: boolean;
  privateChats: boolean;
  groups: boolean;
  channels: boolean;
  stories: boolean;
  reactions: boolean;
  showCounter: boolean;
  mutedChats: boolean;
  inAppSound: boolean;
  inAppVibration: boolean;
  inAppPreview: boolean;
  chatSound: boolean;
  popups: boolean;
  contactJoined: boolean;
  pinnedMessages: boolean;
  restartOnClose: boolean;
  backgroundConnection: boolean;
  repeatInterval: 0 | 60 | 300 | 3600;
};

export type MediaAutoDownloadSettings = {
  cellular: boolean;
  wifi: boolean;
  roaming: boolean;
  photoLimitMb: number;
  videoLimitMb: number;
  fileLimitMb: number;
};

export type SaveToGallerySettings = {
  privateChats: boolean;
  groups: boolean;
  channels: boolean;
};

export type MediaSettings = {
  autoDownload: MediaAutoDownloadSettings;
  autoplayVideo: boolean;
  autoplayGif: boolean;
  streaming: boolean;
  pauseMusicWhenRecording: boolean;
  pauseMusicWhenMedia: boolean;
  saveToGallery: SaveToGallerySettings;
  callDataSaving: CallDataSaving;
};

export type ProxySettings = {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
};

export type EnergySavingSettings = {
  enabled: boolean;
  threshold: number;
  stickers: boolean;
  emoji: boolean;
  chatAnimations: boolean;
  callAnimations: boolean;
  autoplayVideo: boolean;
  autoplayGif: boolean;
  particles: boolean;
  smoothTransitions: boolean;
};

export type LocalClientSettings = {
  theme: ThemePreference;
  fontScale: FontScale;
  density: DensityPreference;
  accent: AccentPreference;
  locale: LocalePreference;
  messageTextSize: number;
  bubbleRadius: number;
  chatListLayout: ChatListLayout;
  media: MediaSettings;
  proxy: ProxySettings;
  energySaving: EnergySavingSettings;
  notifications: NotificationSettings;
  cachePolicy: CachePolicy;
};

export const DEFAULT_LOCAL_SETTINGS: LocalClientSettings = {
  theme: "system",
  fontScale: 1,
  density: "comfortable",
  accent: "violet",
  locale: "ru",
  messageTextSize: 16,
  bubbleRadius: 17,
  chatListLayout: "two-line",
  media: {
    autoDownload: { cellular: true, wifi: true, roaming: true, photoLimitMb: 10, videoLimitMb: 50, fileLimitMb: 3 },
    autoplayVideo: true,
    autoplayGif: true,
    streaming: true,
    pauseMusicWhenRecording: true,
    pauseMusicWhenMedia: false,
    saveToGallery: { privateChats: false, groups: false, channels: false },
    callDataSaving: "roaming",
  },
  proxy: { enabled: false, protocol: "socks5", host: "", port: 1080, username: "", password: "" },
  energySaving: { enabled: false, threshold: 10, stickers: true, emoji: true, chatAnimations: true, callAnimations: true, autoplayVideo: true, autoplayGif: true, particles: true, smoothTransitions: true },
  notifications: {
    desktop: true, sound: false, preview: true, allAccounts: true, privateChats: true, groups: true, channels: true, stories: false, reactions: true,
    showCounter: true, mutedChats: false, inAppSound: true, inAppVibration: true, inAppPreview: true, chatSound: true, popups: true,
    contactJoined: true, pinnedMessages: true, restartOnClose: true, backgroundConnection: true, repeatInterval: 3600,
  },
  cachePolicy: "standard",
};

const SETTINGS_KEY = "enter-local-settings";
const LEGACY_NOTIFICATION_KEY = "enter-notification-settings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberInRange(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function textOr(value: unknown, fallback: string, max = 256) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
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
  return {
    theme: stored.theme === "light" || stored.theme === "dark" ? stored.theme : DEFAULT_LOCAL_SETTINGS.theme,
    fontScale: stored.fontScale === 0.9 || stored.fontScale === 1.1 ? stored.fontScale : DEFAULT_LOCAL_SETTINGS.fontScale,
    density: stored.density === "compact" ? stored.density : DEFAULT_LOCAL_SETTINGS.density,
    accent: stored.accent === "blue" || stored.accent === "green" || stored.accent === "rose" ? stored.accent : DEFAULT_LOCAL_SETTINGS.accent,
    locale: stored.locale === "en" ? stored.locale : DEFAULT_LOCAL_SETTINGS.locale,
    messageTextSize: numberInRange(stored.messageTextSize, 14, 22, DEFAULT_LOCAL_SETTINGS.messageTextSize),
    bubbleRadius: numberInRange(stored.bubbleRadius, 6, 22, DEFAULT_LOCAL_SETTINGS.bubbleRadius),
    chatListLayout: stored.chatListLayout === "three-line" ? "three-line" : DEFAULT_LOCAL_SETTINGS.chatListLayout,
    media: {
      autoDownload: {
        cellular: booleanOr((stored.media as Record<string, unknown> | undefined)?.autoDownload && ((stored.media as Record<string, unknown>).autoDownload as Record<string, unknown>).cellular, DEFAULT_LOCAL_SETTINGS.media.autoDownload.cellular),
        wifi: booleanOr((stored.media as Record<string, unknown> | undefined)?.autoDownload && ((stored.media as Record<string, unknown>).autoDownload as Record<string, unknown>).wifi, DEFAULT_LOCAL_SETTINGS.media.autoDownload.wifi),
        roaming: booleanOr((stored.media as Record<string, unknown> | undefined)?.autoDownload && ((stored.media as Record<string, unknown>).autoDownload as Record<string, unknown>).roaming, DEFAULT_LOCAL_SETTINGS.media.autoDownload.roaming),
        photoLimitMb: numberInRange(((stored.media as Record<string, unknown> | undefined)?.autoDownload as Record<string, unknown> | undefined)?.photoLimitMb, 1, 100, DEFAULT_LOCAL_SETTINGS.media.autoDownload.photoLimitMb),
        videoLimitMb: numberInRange(((stored.media as Record<string, unknown> | undefined)?.autoDownload as Record<string, unknown> | undefined)?.videoLimitMb, 1, 500, DEFAULT_LOCAL_SETTINGS.media.autoDownload.videoLimitMb),
        fileLimitMb: numberInRange(((stored.media as Record<string, unknown> | undefined)?.autoDownload as Record<string, unknown> | undefined)?.fileLimitMb, 1, 100, DEFAULT_LOCAL_SETTINGS.media.autoDownload.fileLimitMb),
      },
      autoplayVideo: booleanOr((stored.media as Record<string, unknown> | undefined)?.autoplayVideo, DEFAULT_LOCAL_SETTINGS.media.autoplayVideo),
      autoplayGif: booleanOr((stored.media as Record<string, unknown> | undefined)?.autoplayGif, DEFAULT_LOCAL_SETTINGS.media.autoplayGif),
      streaming: booleanOr((stored.media as Record<string, unknown> | undefined)?.streaming, DEFAULT_LOCAL_SETTINGS.media.streaming),
      pauseMusicWhenRecording: booleanOr((stored.media as Record<string, unknown> | undefined)?.pauseMusicWhenRecording, DEFAULT_LOCAL_SETTINGS.media.pauseMusicWhenRecording),
      pauseMusicWhenMedia: booleanOr((stored.media as Record<string, unknown> | undefined)?.pauseMusicWhenMedia, DEFAULT_LOCAL_SETTINGS.media.pauseMusicWhenMedia),
      saveToGallery: {
        privateChats: booleanOr(((stored.media as Record<string, unknown> | undefined)?.saveToGallery as Record<string, unknown> | undefined)?.privateChats, DEFAULT_LOCAL_SETTINGS.media.saveToGallery.privateChats),
        groups: booleanOr(((stored.media as Record<string, unknown> | undefined)?.saveToGallery as Record<string, unknown> | undefined)?.groups, DEFAULT_LOCAL_SETTINGS.media.saveToGallery.groups),
        channels: booleanOr(((stored.media as Record<string, unknown> | undefined)?.saveToGallery as Record<string, unknown> | undefined)?.channels, DEFAULT_LOCAL_SETTINGS.media.saveToGallery.channels),
      },
      callDataSaving: (stored.media as Record<string, unknown> | undefined)?.callDataSaving === "always" || (stored.media as Record<string, unknown> | undefined)?.callDataSaving === "never" ? (stored.media as Record<string, unknown>).callDataSaving as "always" | "never" : DEFAULT_LOCAL_SETTINGS.media.callDataSaving,
    },
    proxy: {
      enabled: booleanOr((stored.proxy as Record<string, unknown> | undefined)?.enabled, DEFAULT_LOCAL_SETTINGS.proxy.enabled),
      protocol: (stored.proxy as Record<string, unknown> | undefined)?.protocol === "http" ? "http" : DEFAULT_LOCAL_SETTINGS.proxy.protocol,
      host: textOr((stored.proxy as Record<string, unknown> | undefined)?.host, DEFAULT_LOCAL_SETTINGS.proxy.host, 256),
      port: numberInRange((stored.proxy as Record<string, unknown> | undefined)?.port, 1, 65535, DEFAULT_LOCAL_SETTINGS.proxy.port),
      username: textOr((stored.proxy as Record<string, unknown> | undefined)?.username, DEFAULT_LOCAL_SETTINGS.proxy.username, 128),
      password: textOr((stored.proxy as Record<string, unknown> | undefined)?.password, DEFAULT_LOCAL_SETTINGS.proxy.password, 256),
    },
    energySaving: {
      enabled: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.enabled, DEFAULT_LOCAL_SETTINGS.energySaving.enabled),
      threshold: numberInRange((stored.energySaving as Record<string, unknown> | undefined)?.threshold, 5, 50, DEFAULT_LOCAL_SETTINGS.energySaving.threshold),
      stickers: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.stickers, DEFAULT_LOCAL_SETTINGS.energySaving.stickers),
      emoji: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.emoji, DEFAULT_LOCAL_SETTINGS.energySaving.emoji),
      chatAnimations: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.chatAnimations, DEFAULT_LOCAL_SETTINGS.energySaving.chatAnimations),
      callAnimations: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.callAnimations, DEFAULT_LOCAL_SETTINGS.energySaving.callAnimations),
      autoplayVideo: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.autoplayVideo, DEFAULT_LOCAL_SETTINGS.energySaving.autoplayVideo),
      autoplayGif: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.autoplayGif, DEFAULT_LOCAL_SETTINGS.energySaving.autoplayGif),
      particles: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.particles, DEFAULT_LOCAL_SETTINGS.energySaving.particles),
      smoothTransitions: booleanOr((stored.energySaving as Record<string, unknown> | undefined)?.smoothTransitions, DEFAULT_LOCAL_SETTINGS.energySaving.smoothTransitions),
    },
    notifications: {
      desktop: typeof notifications?.desktop === "boolean" ? notifications.desktop : DEFAULT_LOCAL_SETTINGS.notifications.desktop,
      sound: typeof notifications?.sound === "boolean" ? notifications.sound : DEFAULT_LOCAL_SETTINGS.notifications.sound,
      preview: typeof notifications?.preview === "boolean" ? notifications.preview : DEFAULT_LOCAL_SETTINGS.notifications.preview,
      allAccounts: booleanOr(notifications?.allAccounts, DEFAULT_LOCAL_SETTINGS.notifications.allAccounts),
      privateChats: booleanOr(notifications?.privateChats, DEFAULT_LOCAL_SETTINGS.notifications.privateChats),
      groups: booleanOr(notifications?.groups, DEFAULT_LOCAL_SETTINGS.notifications.groups),
      channels: booleanOr(notifications?.channels, DEFAULT_LOCAL_SETTINGS.notifications.channels),
      stories: booleanOr(notifications?.stories, DEFAULT_LOCAL_SETTINGS.notifications.stories),
      reactions: booleanOr(notifications?.reactions, DEFAULT_LOCAL_SETTINGS.notifications.reactions),
      showCounter: booleanOr(notifications?.showCounter, DEFAULT_LOCAL_SETTINGS.notifications.showCounter),
      mutedChats: booleanOr(notifications?.mutedChats, DEFAULT_LOCAL_SETTINGS.notifications.mutedChats),
      inAppSound: booleanOr(notifications?.inAppSound, DEFAULT_LOCAL_SETTINGS.notifications.inAppSound),
      inAppVibration: booleanOr(notifications?.inAppVibration, DEFAULT_LOCAL_SETTINGS.notifications.inAppVibration),
      inAppPreview: booleanOr(notifications?.inAppPreview, DEFAULT_LOCAL_SETTINGS.notifications.inAppPreview),
      chatSound: booleanOr(notifications?.chatSound, DEFAULT_LOCAL_SETTINGS.notifications.chatSound),
      popups: booleanOr(notifications?.popups, DEFAULT_LOCAL_SETTINGS.notifications.popups),
      contactJoined: booleanOr(notifications?.contactJoined, DEFAULT_LOCAL_SETTINGS.notifications.contactJoined),
      pinnedMessages: booleanOr(notifications?.pinnedMessages, DEFAULT_LOCAL_SETTINGS.notifications.pinnedMessages),
      restartOnClose: booleanOr(notifications?.restartOnClose, DEFAULT_LOCAL_SETTINGS.notifications.restartOnClose),
      backgroundConnection: booleanOr(notifications?.backgroundConnection, DEFAULT_LOCAL_SETTINGS.notifications.backgroundConnection),
      repeatInterval: notifications?.repeatInterval === 0 || notifications?.repeatInterval === 60 || notifications?.repeatInterval === 300 || notifications?.repeatInterval === 3600 ? notifications.repeatInterval : DEFAULT_LOCAL_SETTINGS.notifications.repeatInterval,
    },
    cachePolicy: stored.cachePolicy === "minimal" || stored.cachePolicy === "disabled" ? stored.cachePolicy : DEFAULT_LOCAL_SETTINGS.cachePolicy,
  };
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
  root.lang = settings.locale;
  root.style.setProperty("--font-scale", String(settings.fontScale));
  root.style.setProperty("--message-font-size", `${settings.messageTextSize}px`);
  root.style.setProperty("--bubble-radius", `${settings.bubbleRadius}px`);
  root.style.setProperty("--primary", accent.primary);
  root.style.setProperty("--primary-foreground", accent.foreground);
  root.style.setProperty("--accent", accent.accent);
  root.style.setProperty("--ring", accent.ring);
}
