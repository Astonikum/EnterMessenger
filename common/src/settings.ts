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

export type DebugSettings = {
  showCommonElements: boolean;
};

export type ClientSettings = {
  theme: ThemePreference;
  fontScale: FontScale;
  density: DensityPreference;
  accent: AccentPreference;
  locale: LocalePreference;
  messageTextSize: number;
  bubbleRadius: number;
  chatListLayout: ChatListLayout;
  notifications: NotificationSettings;
  media: MediaSettings;
  proxy: ProxySettings;
  energySaving: EnergySavingSettings;
  cachePolicy: CachePolicy;
  debug: DebugSettings;
};

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  theme: "system",
  fontScale: 1,
  density: "comfortable",
  accent: "violet",
  locale: "ru",
  messageTextSize: 16,
  bubbleRadius: 17,
  chatListLayout: "two-line",
  notifications: {
    desktop: true, preview: true, sound: false, allAccounts: true, privateChats: true, groups: true, channels: true, stories: false, reactions: true,
    showCounter: true, mutedChats: false, inAppSound: true, inAppVibration: true, inAppPreview: true, chatSound: true, popups: true,
    contactJoined: true, pinnedMessages: true, restartOnClose: true, backgroundConnection: true, repeatInterval: 3600,
  },
  media: {
    autoDownload: { cellular: true, wifi: true, roaming: true, photoLimitMb: 10, videoLimitMb: 50, fileLimitMb: 3 },
    autoplayVideo: true, autoplayGif: true, streaming: true, pauseMusicWhenRecording: true, pauseMusicWhenMedia: false,
    saveToGallery: { privateChats: false, groups: false, channels: false }, callDataSaving: "roaming",
  },
  proxy: { enabled: false, protocol: "socks5", host: "", port: 1080, username: "", password: "" },
  energySaving: { enabled: false, threshold: 10, stickers: true, emoji: true, chatAnimations: true, callAnimations: true, autoplayVideo: true, autoplayGif: true, particles: true, smoothTransitions: true },
  cachePolicy: "standard",
  debug: { showCommonElements: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberInRange(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function textOr(value: unknown, fallback: string, max = 256) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

export function copyDefaultClientSettings(): ClientSettings {
  return {
    ...DEFAULT_CLIENT_SETTINGS,
    notifications: { ...DEFAULT_CLIENT_SETTINGS.notifications },
    media: { ...DEFAULT_CLIENT_SETTINGS.media, autoDownload: { ...DEFAULT_CLIENT_SETTINGS.media.autoDownload }, saveToGallery: { ...DEFAULT_CLIENT_SETTINGS.media.saveToGallery } },
    proxy: { ...DEFAULT_CLIENT_SETTINGS.proxy },
    energySaving: { ...DEFAULT_CLIENT_SETTINGS.energySaving },
    debug: { ...DEFAULT_CLIENT_SETTINGS.debug },
  };
}

export function normalizeClientSettings(value: unknown): ClientSettings {
  const input = isRecord(value) ? value : {};
  const notifications = isRecord(input.notifications) ? input.notifications : {};
  const media = isRecord(input.media) ? input.media : {};
  const autoDownload = isRecord(media.autoDownload) ? media.autoDownload : {};
  const saveToGallery = isRecord(media.saveToGallery) ? media.saveToGallery : {};
  const proxy = isRecord(input.proxy) ? input.proxy : {};
  const energySaving = isRecord(input.energySaving) ? input.energySaving : {};
  const debug = isRecord(input.debug) ? input.debug : {};
  const defaults = copyDefaultClientSettings();
  const legacyTextSize: FontScale = input.textSize === "small" ? 0.9 : input.textSize === "large" ? 1.1 : 1;
  const legacyLanguage: LocalePreference = input.language === "en" ? "en" : "ru";
  const legacyCache = isRecord(input.cache) ? input.cache : {};
  const legacyRetention = typeof legacyCache.retentionDays === "number" ? legacyCache.retentionDays : 30;

  return {
    theme: enumOr(input.theme, ["system", "light", "dark"], defaults.theme),
    fontScale: input.fontScale === 0.9 || input.fontScale === 1.1 ? input.fontScale : input.fontScale === 1 ? 1 : legacyTextSize,
    density: enumOr(input.density, ["comfortable", "compact"], defaults.density),
    accent: enumOr(input.accent, ["violet", "blue", "green", "rose"], defaults.accent),
    locale: enumOr(input.locale, ["ru", "en"], legacyLanguage),
    messageTextSize: numberInRange(input.messageTextSize, 14, 22, defaults.messageTextSize),
    bubbleRadius: numberInRange(input.bubbleRadius, 6, 22, defaults.bubbleRadius),
    chatListLayout: enumOr(input.chatListLayout, ["two-line", "three-line"], defaults.chatListLayout),
    media: {
      autoDownload: {
        cellular: booleanOr(autoDownload.cellular, defaults.media.autoDownload.cellular),
        wifi: booleanOr(autoDownload.wifi, defaults.media.autoDownload.wifi),
        roaming: booleanOr(autoDownload.roaming, defaults.media.autoDownload.roaming),
        photoLimitMb: numberInRange(autoDownload.photoLimitMb, 1, 100, defaults.media.autoDownload.photoLimitMb),
        videoLimitMb: numberInRange(autoDownload.videoLimitMb, 1, 500, defaults.media.autoDownload.videoLimitMb),
        fileLimitMb: numberInRange(autoDownload.fileLimitMb, 1, 100, defaults.media.autoDownload.fileLimitMb),
      },
      autoplayVideo: booleanOr(media.autoplayVideo, defaults.media.autoplayVideo),
      autoplayGif: booleanOr(media.autoplayGif, defaults.media.autoplayGif),
      streaming: booleanOr(media.streaming, defaults.media.streaming),
      pauseMusicWhenRecording: booleanOr(media.pauseMusicWhenRecording, defaults.media.pauseMusicWhenRecording),
      pauseMusicWhenMedia: booleanOr(media.pauseMusicWhenMedia, defaults.media.pauseMusicWhenMedia),
      saveToGallery: {
        privateChats: booleanOr(saveToGallery.privateChats, defaults.media.saveToGallery.privateChats),
        groups: booleanOr(saveToGallery.groups, defaults.media.saveToGallery.groups),
        channels: booleanOr(saveToGallery.channels, defaults.media.saveToGallery.channels),
      },
      callDataSaving: enumOr(media.callDataSaving, ["never", "roaming", "always"], defaults.media.callDataSaving),
    },
    proxy: {
      enabled: booleanOr(proxy.enabled, defaults.proxy.enabled),
      protocol: enumOr(proxy.protocol, ["http", "socks5"], defaults.proxy.protocol),
      host: textOr(proxy.host, defaults.proxy.host, 256),
      port: numberInRange(proxy.port, 1, 65535, defaults.proxy.port),
      username: textOr(proxy.username, defaults.proxy.username, 128),
      password: textOr(proxy.password, defaults.proxy.password, 256),
    },
    energySaving: {
      enabled: booleanOr(energySaving.enabled, defaults.energySaving.enabled),
      threshold: numberInRange(energySaving.threshold, 5, 50, defaults.energySaving.threshold),
      stickers: booleanOr(energySaving.stickers, defaults.energySaving.stickers),
      emoji: booleanOr(energySaving.emoji, defaults.energySaving.emoji),
      chatAnimations: booleanOr(energySaving.chatAnimations, defaults.energySaving.chatAnimations),
      callAnimations: booleanOr(energySaving.callAnimations, defaults.energySaving.callAnimations),
      autoplayVideo: booleanOr(energySaving.autoplayVideo, defaults.energySaving.autoplayVideo),
      autoplayGif: booleanOr(energySaving.autoplayGif, defaults.energySaving.autoplayGif),
      particles: booleanOr(energySaving.particles, defaults.energySaving.particles),
      smoothTransitions: booleanOr(energySaving.smoothTransitions, defaults.energySaving.smoothTransitions),
    },
    notifications: {
      desktop: booleanOr(notifications.desktop, booleanOr(notifications.enabled, defaults.notifications.desktop)),
      preview: booleanOr(notifications.preview, defaults.notifications.preview),
      sound: booleanOr(notifications.sound, defaults.notifications.sound),
      allAccounts: booleanOr(notifications.allAccounts, defaults.notifications.allAccounts),
      privateChats: booleanOr(notifications.privateChats, defaults.notifications.privateChats),
      groups: booleanOr(notifications.groups, defaults.notifications.groups),
      channels: booleanOr(notifications.channels, defaults.notifications.channels),
      stories: booleanOr(notifications.stories, defaults.notifications.stories),
      reactions: booleanOr(notifications.reactions, defaults.notifications.reactions),
      showCounter: booleanOr(notifications.showCounter, defaults.notifications.showCounter),
      mutedChats: booleanOr(notifications.mutedChats, defaults.notifications.mutedChats),
      inAppSound: booleanOr(notifications.inAppSound, defaults.notifications.inAppSound),
      inAppVibration: booleanOr(notifications.inAppVibration, defaults.notifications.inAppVibration),
      inAppPreview: booleanOr(notifications.inAppPreview, defaults.notifications.inAppPreview),
      chatSound: booleanOr(notifications.chatSound, defaults.notifications.chatSound),
      popups: booleanOr(notifications.popups, defaults.notifications.popups),
      contactJoined: booleanOr(notifications.contactJoined, defaults.notifications.contactJoined),
      pinnedMessages: booleanOr(notifications.pinnedMessages, defaults.notifications.pinnedMessages),
      restartOnClose: booleanOr(notifications.restartOnClose, defaults.notifications.restartOnClose),
      backgroundConnection: booleanOr(notifications.backgroundConnection, defaults.notifications.backgroundConnection),
      repeatInterval: notifications.repeatInterval === 0 || notifications.repeatInterval === 60 || notifications.repeatInterval === 300 || notifications.repeatInterval === 3600 ? notifications.repeatInterval : defaults.notifications.repeatInterval,
    },
    cachePolicy: enumOr(input.cachePolicy, ["standard", "minimal", "disabled"], legacyRetention <= 0 ? "disabled" : legacyRetention <= 7 ? "minimal" : defaults.cachePolicy),
    debug: { showCommonElements: booleanOr(debug.showCommonElements, defaults.debug.showCommonElements) },
  };
}
