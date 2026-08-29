import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Image, Modal, PanResponder, Platform, Pressable, Share, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { ResizeMode, Video, type AVPlaybackStatus } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import * as Network from "expo-network";
import { fromByteArray } from "base64-js";
import { downloadMedia } from "../rn-api";
import { decryptMedia } from "../media";
import type { MessageAttachment, Profile } from "../types";
import type { MobileSettings } from "../settings";
import { colors, fonts, radii } from "../theme";
import { friendlyError } from "../client-errors";
import { Icon } from "./Icon";

function formatFileSize(size: number) {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(size > 10 * 1024 * 1024 ? 0 : 1)} МБ`;
}

function formatPlaybackTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

const speedOptions = [
  { value: 0.5, label: "Медленно" },
  { value: 0.75, label: "Чуть медленнее" },
  { value: 1, label: "Стандартно" },
  { value: 1.5, label: "Быстро" },
  { value: 2, label: "Очень быстро" },
];

function extensionFor(attachment: MessageAttachment) {
  const extension = attachment.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return extension || (attachment.kind === "image" ? "jpg" : attachment.kind === "video" ? "mp4" : "bin");
}

const DOWNLOAD_DIRECTORY_KEY = "enter-download-directory";

async function saveNativeFile(uri: string, attachment: MessageAttachment, toGallery = false) {
  if (Platform.OS === "web") {
    const link = document.createElement("a");
    link.href = uri;
    link.download = attachment.name;
    link.click();
    return;
  }
  if (toGallery && (attachment.kind === "image" || attachment.kind === "video")) {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) throw new Error("Доступ к галерее не предоставлен");
    await MediaLibrary.createAssetAsync(uri);
    return;
  }
  if (Platform.OS === "android") {
    let directoryUri = await AsyncStorage.getItem(DOWNLOAD_DIRECTORY_KEY);
    if (!directoryUri) {
      const suggestedDirectory = FileSystem.StorageAccessFramework.getUriForDirectoryInRoot("Download");
      const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(suggestedDirectory);
      if (!permissions.granted) throw new Error("Доступ к папке загрузок не предоставлен");
      directoryUri = permissions.directoryUri;
      await AsyncStorage.setItem(DOWNLOAD_DIRECTORY_KEY, directoryUri);
    }
    try {
      const targetUri = await FileSystem.StorageAccessFramework.createFileAsync(directoryUri, attachment.name, attachment.mimeType);
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      await FileSystem.StorageAccessFramework.writeAsStringAsync(targetUri, base64, { encoding: FileSystem.EncodingType.Base64 });
      return;
    } catch {
      await AsyncStorage.removeItem(DOWNLOAD_DIRECTORY_KEY);
    }
  }
  await Share.share({ message: attachment.name, url: uri });
}

function saveWithFeedback(uri: string, attachment: MessageAttachment) {
  void saveNativeFile(uri, attachment).catch((reason) => {
    Alert.alert("Не удалось сохранить файл", friendlyError(reason, "Попробуйте ещё раз"));
  });
}

type MediaSettings = MobileSettings["media"];

function mediaLimitBytes(attachment: MessageAttachment, settings: MediaSettings) {
  const limitMb = attachment.kind === "image" ? settings.autoDownload.photoLimitMb : attachment.kind === "video" ? settings.autoDownload.videoLimitMb : settings.autoDownload.fileLimitMb;
  return limitMb * 1024 * 1024;
}

function autoDownloadAllowed(attachment: MessageAttachment, settings: MediaSettings | undefined, network: "wifi" | "cellular" | "other") {
  if (!settings) return true;
  const networkAllowed = network === "cellular" ? settings.autoDownload.cellular : network === "wifi" ? settings.autoDownload.wifi : true;
  return networkAllowed && attachment.size <= mediaLimitBytes(attachment, settings);
}

function touchDistance(touches: readonly { pageX: number; pageY: number }[]) {
  if (touches.length < 2) return 0;
  const [first, second] = touches;
  return Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY);
}

function MediaViewer({ uri, attachment, onClose }: { uri: string; attachment: MessageAttachment; onClose: () => void }) {
  const mediaRef = useRef<Video>(null);
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [mediaSize, setMediaSize] = useState<{ width: number; height: number }>();
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const [positionMillis, setPositionMillis] = useState(0);
  const [durationMillis, setDurationMillis] = useState(0);
  const [progressWidth, setProgressWidth] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [volume, setVolume] = useState(1);
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const gestureRef = useRef({ distance: 0, zoom: 1, offset: { x: 0, y: 0 } });
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();

  useEffect(() => () => {
    const player = mediaRef.current;
    if (player) void player.unloadAsync().catch(() => undefined);
  }, []);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gestureState) => gestureState.numberActiveTouches >= 2 || (zoomRef.current > 1 && (Math.abs(gestureState.dx) > 3 || Math.abs(gestureState.dy) > 3)),
    onPanResponderGrant: (event) => {
      gestureRef.current = { distance: touchDistance(event.nativeEvent.touches), zoom: zoomRef.current, offset: offsetRef.current };
    },
    onPanResponderMove: (event, gestureState) => {
      const distance = touchDistance(event.nativeEvent.touches);
      if (distance > 0 && gestureRef.current.distance > 0) {
        const nextZoom = Math.max(1, Math.min(4, Number((gestureRef.current.zoom * distance / gestureRef.current.distance).toFixed(2))));
        zoomRef.current = nextZoom;
        setZoom(nextZoom);
        return;
      }
      if (zoomRef.current <= 1) return;
      const nextOffset = { x: gestureRef.current.offset.x + gestureState.dx, y: gestureRef.current.offset.y + gestureState.dy };
      offsetRef.current = nextOffset;
      setOffset(nextOffset);
    },
    onPanResponderRelease: () => {
      if (zoomRef.current <= 1) {
        zoomRef.current = 1;
        offsetRef.current = { x: 0, y: 0 };
        setZoom(1);
        setOffset({ x: 0, y: 0 });
      }
      gestureRef.current.distance = 0;
    },
    onPanResponderTerminate: () => {
      gestureRef.current.distance = 0;
    },
  }), []);

  useEffect(() => {
    if (attachment.kind === "image" || !mediaRef.current) return;
    void mediaRef.current.setRateAsync(speed, true);
    void mediaRef.current.setVolumeAsync(volume);
  }, [attachment.kind, speed, volume]);

  const handlePlaybackStatus = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if (status.error) setPlaybackError(true);
      return;
    }
    setPlaying(status.isPlaying);
    setPositionMillis(status.positionMillis);
    setDurationMillis(status.durationMillis ?? 0);
  };

  const togglePlayback = () => {
    if (!mediaRef.current) return;
    void (playing ? mediaRef.current.pauseAsync() : mediaRef.current.playAsync());
  };

  const seekTo = (locationX: number) => {
    if (!mediaRef.current || !durationMillis || !progressWidth) return;
    const ratio = Math.max(0, Math.min(1, locationX / progressWidth));
    void mediaRef.current.setPositionAsync(ratio * durationMillis);
  };

  const measuredMediaSize = mediaSize ?? (attachment.kind === "video" ? { width: 16, height: 9 } : undefined);
  const mediaFrame = measuredMediaSize
    ? (() => {
        const scale = Math.min(Math.max(1, viewportWidth - 48) / measuredMediaSize.width, Math.max(1, viewportHeight - 160) / measuredMediaSize.height);
        return { width: measuredMediaSize.width * Math.max(0.01, scale), height: measuredMediaSize.height * Math.max(0.01, scale) };
      })()
    : attachment.kind === "image"
      ? { width: Math.min(Math.max(viewportWidth - 48, 1), 360), height: Math.min(Math.max(viewportHeight - 160, 1), 360) }
      : attachment.kind === "audio" ? { width: Math.min(viewportWidth - 48, 360), height: 58 } : styles.viewerFallback;
  const mediaTransform = [{ translateX: offset.x }, { translateY: offset.y }, { scale: zoom }, { rotate: `${rotation}deg` }];
  const content = attachment.kind === "image"
    ? <Image source={{ uri }} onLoad={(event) => setMediaSize({ width: event.nativeEvent.source.width, height: event.nativeEvent.source.height })} style={styles.mediaFill} resizeMode="contain" />
    : attachment.kind === "audio"
      ? <View style={styles.audioViewerCard}><View style={styles.audioViewerIcon}><Icon name="mic" size={28} color={colors.primary} /></View><Text style={styles.audioViewerName} numberOfLines={1}>{attachment.name}</Text><Video ref={mediaRef} source={{ uri }} onPlaybackStatusUpdate={handlePlaybackStatus} shouldPlay resizeMode={ResizeMode.CONTAIN} style={styles.audioEngine} /></View>
      : <Video ref={mediaRef} source={{ uri }} onError={() => setPlaybackError(true)} onReadyForDisplay={(event) => { const { width, height } = event.naturalSize; if (width && height) setMediaSize({ width, height }); }} onPlaybackStatusUpdate={handlePlaybackStatus} shouldPlay resizeMode={ResizeMode.CONTAIN} style={styles.mediaFill} />;
  const mediaKind = attachment.kind === "image" ? "Фото" : attachment.kind === "video" ? "Видео" : "Аудио";

  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={styles.viewer}>
    <Pressable style={styles.viewerContent} onPress={onClose}>
      <View style={styles.viewerMedia}>
      <Pressable {...panResponder.panHandlers} style={[mediaFrame, { transform: mediaTransform }]} onPress={(event) => event.stopPropagation()}>{content}{playbackError && <Text style={styles.playbackError}>Не удалось воспроизвести файл</Text>}</Pressable>
      </View>
    </Pressable>
    <View style={styles.viewerTopBar}>
      <View style={styles.viewerInfo}><Text style={styles.viewerName} numberOfLines={1}>{attachment.name}</Text><Text style={styles.viewerSize}>{mediaKind} · {formatFileSize(attachment.size)}</Text></View>
      <View style={styles.viewerTools}>
        {(attachment.kind === "image" || attachment.kind === "video") && <Pressable accessibilityLabel="Повернуть налево" style={styles.viewerIconButton} onPress={() => setRotation((value) => value - 90)}><Icon name="rotateLeft" size={18} color="#fff" /></Pressable>}
        <Pressable accessibilityLabel="Сохранить в загрузки" style={styles.viewerIconButton} onPress={() => saveWithFeedback(uri, attachment)}><Icon name="download" size={18} color="#fff" /></Pressable>
        <Pressable accessibilityLabel="Закрыть просмотр" style={styles.viewerIconButton} onPress={onClose}><Icon name="close" size={20} color="#fff" /></Pressable>
      </View>
    </View>
    {(attachment.kind === "video" || attachment.kind === "audio") && <View style={styles.viewerDock}>
      <View style={styles.playerControls}>
        <Pressable accessibilityLabel={playing ? "Пауза" : "Воспроизвести"} style={styles.viewerIconButton} onPress={togglePlayback}><Icon name={playing ? "pause" : "play"} size={18} color="#fff" /></Pressable>
        <Pressable style={styles.progressTrack} onLayout={(event) => setProgressWidth(event.nativeEvent.layout.width)} onPress={(event) => seekTo(event.nativeEvent.locationX)}><View style={[styles.progressFill, { width: `${durationMillis ? Math.min(100, positionMillis / durationMillis * 100) : 0}%` }]} /></Pressable>
        <Text style={styles.playerTime}>{formatPlaybackTime(positionMillis)} / {formatPlaybackTime(durationMillis)}</Text>
        <Pressable accessibilityLabel={volume ? "Выключить звук" : "Включить звук"} style={styles.viewerIconButton} onPress={() => setVolume((value) => value > 0 ? 0 : 1)}><Icon name={volume ? "volume" : "volumeOff"} size={18} color="#fff" /></Pressable>
        <Pressable accessibilityLabel={`Скорость ${speed}x`} style={styles.viewerIconButton} onPress={() => setSpeedOpen((value) => !value)}><Icon name="speed" size={18} color="#fff" /></Pressable>
      </View>
      {speedOpen && <View style={styles.speedMenu}>
        <Text style={styles.speedMenuTitle}>Скорость</Text>
        {speedOptions.map((option) => <Pressable key={option.value} style={[styles.speedOption, option.value === speed && styles.speedOptionActive]} onPress={() => { setSpeed(option.value); setSpeedOpen(false); }}><Text style={[styles.speedOptionValue, option.value === speed && styles.speedOptionSelected]}>{option.value}×</Text><Text style={[styles.speedOptionLabel, option.value === speed && styles.speedOptionSelected]}>{option.label}</Text>{option.value === speed && <Text style={styles.speedOptionCheck}>✓</Text>}</Pressable>)}
      </View>}
    </View>}
  </View></Modal>;
}

export function MediaBubble({ profile, attachment, grouped = false, captioned = false, outgoing = false, mediaSettings, energySavingActive = false, onAttachmentLongPress }: { profile: Profile; attachment: MessageAttachment; grouped?: boolean; captioned?: boolean; outgoing?: boolean; mediaSettings?: MediaSettings; energySavingActive?: boolean; onAttachmentLongPress?: (attachment: MessageAttachment, save: () => void) => void }) {
  const [uri, setUri] = useState<string>();
  const [error, setError] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [manualDownload, setManualDownload] = useState(false);
  const [network, setNetwork] = useState<"wifi" | "cellular" | "other">("other");
  const gallerySaved = useRef(false);

  useEffect(() => {
    if (Platform.OS === "web") return;
    let mounted = true;
    const applyNetwork = (state: Network.NetworkState) => {
      if (!mounted) return;
      setNetwork(state.type === Network.NetworkStateType.WIFI ? "wifi" : state.type === Network.NetworkStateType.CELLULAR ? "cellular" : "other");
    };
    void Network.getNetworkStateAsync().then(applyNetwork).catch(() => undefined);
    const subscription = Network.addNetworkStateListener(applyNetwork);
    return () => { mounted = false; subscription.remove(); };
  }, []);

  const shouldDownload = manualDownload || autoDownloadAllowed(attachment, mediaSettings, network);

  useEffect(() => {
    setManualDownload(false);
    gallerySaved.current = false;
  }, [attachment.id]);

  function openActions(event: { stopPropagation?: () => void }) {
    event.stopPropagation?.();
    if (uri) onAttachmentLongPress?.(attachment, () => saveWithFeedback(uri, attachment));
  }

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setUri(undefined);
    setError(false);
    if (!shouldDownload) return () => { disposed = true; };
    void downloadMedia(profile, attachment.id)
      .then((ciphertext) => decryptMedia(ciphertext, attachment))
      .then(async (plaintext) => {
        if (Platform.OS === "web") {
          const nextObjectUrl = URL.createObjectURL(new Blob([plaintext.buffer as ArrayBuffer], { type: attachment.mimeType }));
          if (disposed) URL.revokeObjectURL(nextObjectUrl);
          else { objectUrl = nextObjectUrl; setUri(nextObjectUrl); }
          return;
        }
        const directory = FileSystem.cacheDirectory;
        if (!directory) throw new Error("Кэш файлов недоступен");
        const path = `${directory}enter-${attachment.id}.${extensionFor(attachment)}`;
        await FileSystem.writeAsStringAsync(path, fromByteArray(plaintext), { encoding: FileSystem.EncodingType.Base64 });
        if (!gallerySaved.current && mediaSettings?.saveToGallery.privateChats && (attachment.kind === "image" || attachment.kind === "video")) {
          gallerySaved.current = true;
          await saveNativeFile(path, attachment, true).catch(() => undefined);
        }
        if (!disposed) setUri(path);
      })
      .catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.id, attachment.kind, attachment.key, attachment.mimeType, attachment.name, attachment.nonce, attachment.sha256, attachment.size, mediaSettings?.autoDownload.cellular, mediaSettings?.autoDownload.fileLimitMb, mediaSettings?.autoDownload.photoLimitMb, mediaSettings?.autoDownload.roaming, mediaSettings?.autoDownload.videoLimitMb, mediaSettings?.saveToGallery.privateChats, network, profile.id, profile.server, profile.token, shouldDownload]);

  if (error) return <View style={grouped ? styles.groupError : styles.error}><Icon name="error" size={16} color={colors.danger} />{!grouped && <Text style={styles.errorText}>Не удалось загрузить вложение</Text>}</View>;
  if (!uri && !shouldDownload) return <Pressable onPress={() => setManualDownload(true)} style={grouped ? styles.groupLoading : styles.loading}><Icon name="download" size={17} color={colors.primary} />{!grouped && <Text style={styles.loadingText}>Загрузить медиа</Text>}</Pressable>;
  if (!uri) return <View style={grouped ? styles.groupLoading : styles.loading}><Icon name="attach" size={17} color={colors.primary} />{!grouped && <Text style={styles.loadingText}>Загрузка вложения…</Text>}</View>;
  const longPress = onAttachmentLongPress ? openActions : undefined;
  if (attachment.kind === "image") return <><Pressable onPress={() => setViewerOpen(true)} onLongPress={longPress} style={[grouped ? styles.groupImageButton : styles.imageButton, captioned && styles.captionedMedia]}><Image source={{ uri }} onError={() => setError(true)} style={grouped ? styles.groupImage : styles.image} resizeMode="cover" /></Pressable>{viewerOpen && <MediaViewer uri={uri} attachment={attachment} onClose={() => setViewerOpen(false)} />}</>;
  if (attachment.kind === "video") return <><Pressable onPress={() => setViewerOpen(true)} onLongPress={longPress} style={[grouped ? styles.groupVideoButton : styles.videoButton, captioned && styles.captionedMedia]}><Video source={{ uri }} onError={() => setError(true)} resizeMode={ResizeMode.CONTAIN} shouldPlay={Boolean(mediaSettings?.autoplayVideo && !energySavingActive)} style={grouped ? styles.groupVideo : styles.video} /></Pressable>{viewerOpen && <MediaViewer uri={uri} attachment={attachment} onClose={() => setViewerOpen(false)} />}</>;
  if (attachment.kind === "audio") return <><Pressable onPress={() => setViewerOpen(true)} onLongPress={longPress} style={[styles.audioButton, grouped && styles.groupAudioButton, outgoing && styles.outgoingMedia]}><Icon name="mic" size={20} color={outgoing ? colors.primaryText : colors.primary} /><View style={styles.fileCopy}><Text style={[styles.fileName, outgoing && styles.outgoingFileName]} numberOfLines={1}>{attachment.name}</Text><Text style={[styles.fileMeta, outgoing && styles.outgoingFileMeta]}>Аудио · {formatFileSize(attachment.size)}</Text></View></Pressable>{viewerOpen && <MediaViewer uri={uri} attachment={attachment} onClose={() => setViewerOpen(false)} />}</>;
  return <Pressable style={({ pressed }) => [styles.file, grouped && styles.groupFile, outgoing && styles.outgoingMedia, pressed && styles.pressed]} onPress={() => saveWithFeedback(uri, attachment)} onLongPress={longPress}><View style={[styles.fileIcon, outgoing && styles.outgoingFileIcon]}><Icon name="attach" size={19} color={outgoing ? colors.primaryText : colors.primary} /></View><View style={styles.fileCopy}><Text style={[styles.fileName, outgoing && styles.outgoingFileName]} numberOfLines={1}>{attachment.name}</Text><Text style={[styles.fileMeta, outgoing && styles.outgoingFileMeta]}>{formatFileSize(attachment.size)} · сохранить</Text></View><Icon name="share" size={18} color={outgoing ? colors.primaryText : colors.muted} /></Pressable>;
}

export function MediaGroup({ profile, attachments, overlay, captioned = false, outgoing = false, mediaSettings, energySavingActive = false, onAttachmentLongPress }: { profile: Profile; attachments: MessageAttachment[]; overlay?: ReactNode; captioned?: boolean; outgoing?: boolean; mediaSettings?: MediaSettings; energySavingActive?: boolean; onAttachmentLongPress?: (attachment: MessageAttachment, save: () => void) => void }) {
  const content = attachments.length === 1
    ? <MediaBubble profile={profile} attachment={attachments[0]} captioned={captioned} outgoing={outgoing} mediaSettings={mediaSettings} energySavingActive={energySavingActive} onAttachmentLongPress={onAttachmentLongPress} />
    : attachments.length === 3
      ? <View style={[styles.mediaGridThree, captioned && styles.mediaGridCaptioned]}><View style={[styles.mediaGridTall, captioned && styles.mediaGridFlatCell]}><MediaBubble profile={profile} attachment={attachments[0]} grouped outgoing={outgoing} mediaSettings={mediaSettings} energySavingActive={energySavingActive} onAttachmentLongPress={onAttachmentLongPress} /></View><View style={styles.mediaGridSide}><View style={[styles.mediaGridSideCell, captioned && styles.mediaGridFlatCell]}><MediaBubble profile={profile} attachment={attachments[1]} grouped outgoing={outgoing} mediaSettings={mediaSettings} energySavingActive={energySavingActive} onAttachmentLongPress={onAttachmentLongPress} /></View><View style={[styles.mediaGridSideCell, captioned && styles.mediaGridFlatCell]}><MediaBubble profile={profile} attachment={attachments[2]} grouped outgoing={outgoing} mediaSettings={mediaSettings} energySavingActive={energySavingActive} onAttachmentLongPress={onAttachmentLongPress} /></View></View></View>
      : <View style={[styles.mediaGrid, captioned && styles.mediaGridCaptioned]}>{attachments.map((attachment) => <View key={attachment.id} style={[styles.mediaGridCell, captioned && styles.mediaGridFlatCell, { width: attachments.length >= 6 ? "32%" : "49%" }]}><MediaBubble profile={profile} attachment={attachment} grouped outgoing={outgoing} mediaSettings={mediaSettings} energySavingActive={energySavingActive} onAttachmentLongPress={onAttachmentLongPress} /></View>)}</View>;
  return <View style={styles.mediaGroupWrap}>{content}{overlay}</View>;
}

const styles = StyleSheet.create({
  loading: { minWidth: 180, minHeight: 56, borderRadius: radii.md, backgroundColor: "rgba(0,0,0,0.12)", paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  loadingText: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  error: { minHeight: 42, borderRadius: radii.md, backgroundColor: "rgba(120,35,42,0.45)", paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 7 },
  errorText: { color: "#ffcfcb", fontFamily: fonts.body, fontSize: 12 },
  groupLoading: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.12)" },
  groupError: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(120,35,42,0.45)" },
  groupImage: { width: "100%", height: "100%" },
  groupVideo: { width: "100%", height: "100%", backgroundColor: "#08070d", objectFit: "contain" },
  groupAudio: { width: "100%", height: "100%" },
  groupFile: { width: "100%", height: "100%", minWidth: 0, maxWidth: "100%", paddingHorizontal: 6 },
  mediaGroupWrap: { position: "relative", width: "100%" },
  captionedMedia: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  imageButton: { overflow: "hidden", borderRadius: radii.md },
  videoButton: { overflow: "hidden", borderRadius: radii.md, backgroundColor: "#08070d" },
  groupImageButton: { width: "100%", height: "100%" },
  groupVideoButton: { width: "100%", height: "100%", backgroundColor: "#08070d" },
  audioButton: { minWidth: 220, maxWidth: 290, minHeight: 60, borderRadius: radii.md, backgroundColor: "rgba(0,0,0,0.12)", paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 9 },
  groupAudioButton: { width: "100%", height: "100%", minWidth: 0 },
  mediaGrid: { width: "100%", flexDirection: "row", flexWrap: "wrap", gap: 2, overflow: "hidden", borderRadius: radii.md },
  mediaGridCaptioned: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  mediaGridCell: { height: 112, overflow: "hidden", borderRadius: 8 },
  mediaGridFlatCell: { borderRadius: 0 },
  mediaGridThree: { width: "100%", height: 168, flexDirection: "row", gap: 2, overflow: "hidden", borderRadius: radii.md },
  mediaGridTall: { width: "49%", height: "100%", overflow: "hidden", borderRadius: 8 },
  mediaGridSide: { width: "49%", height: "100%", gap: 2 },
  mediaGridSideCell: { flex: 1, overflow: "hidden", borderRadius: 8 },
  image: { width: 250, height: 190, maxWidth: "100%", borderRadius: radii.md },
  video: { width: 260, aspectRatio: 16 / 9, maxWidth: "100%", borderRadius: radii.md, backgroundColor: "#08070d", objectFit: "contain" },
  audio: { width: 260, height: 58, maxWidth: "100%", borderRadius: radii.md },
  file: { minWidth: 220, maxWidth: 290, minHeight: 60, borderRadius: radii.md, backgroundColor: "rgba(0,0,0,0.12)", paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 9 },
  fileIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: "rgba(179,164,255,0.14)", alignItems: "center", justifyContent: "center" },
  fileCopy: { flex: 1, gap: 3 },
  fileName: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 13 },
  fileMeta: { color: colors.muted, fontFamily: fonts.body, fontSize: 11 },
  outgoingMedia: { backgroundColor: "rgba(23,19,31,0.14)" },
  outgoingFileIcon: { backgroundColor: "rgba(23,19,31,0.12)" },
  outgoingFileName: { color: colors.primaryText },
  outgoingFileMeta: { color: "rgba(23,19,31,0.62)" },
  pressed: { opacity: 0.7 },
  viewer: { flex: 1, backgroundColor: "rgba(8,7,13,0.98)" },
  viewerTopBar: { position: "absolute", top: Platform.OS === "ios" ? 48 : 18, left: 14, right: 14, zIndex: 10, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  viewerDock: { position: "absolute", left: 12, right: 12, bottom: Platform.OS === "ios" ? 28 : 16, borderRadius: 18, backgroundColor: "rgba(25,21,31,0.96)", padding: 8, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
  speedMenu: { position: "absolute", bottom: "100%", right: 0, width: 238, marginBottom: 8, borderRadius: 18, backgroundColor: "rgba(25,21,31,0.97)", padding: 7, shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: -8 }, elevation: 12 },
  speedMenuTitle: { color: "rgba(255,255,255,0.62)", fontFamily: fonts.bodySemibold, fontSize: 12, paddingHorizontal: 11, paddingVertical: 8 },
  speedOption: { minHeight: 42, borderRadius: 12, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 12 },
  speedOptionActive: { backgroundColor: "rgba(179,164,255,0.2)" },
  speedOptionValue: { width: 42, color: "rgba(255,255,255,0.9)", fontFamily: fonts.bodySemibold, fontSize: 14 },
  speedOptionLabel: { flex: 1, color: "rgba(255,255,255,0.82)", fontFamily: fonts.body, fontSize: 14 },
  speedOptionSelected: { color: "#d9d2ff" },
  speedOptionCheck: { color: "#b3a4ff", fontFamily: fonts.bodySemibold, fontSize: 16 },
  viewerInfo: { paddingHorizontal: 8, paddingVertical: 4, gap: 3 },
  viewerName: { color: "#fff", fontFamily: fonts.bodySemibold, fontSize: 14 },
  viewerSize: { color: "rgba(255,255,255,0.58)", fontFamily: fonts.body, fontSize: 11 },
  playerControls: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4, paddingBottom: 4 },
  progressTrack: { flex: 1, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.2)", overflow: "hidden", justifyContent: "center" },
  progressFill: { height: "100%", borderRadius: 3, backgroundColor: colors.primary },
  playerTime: { minWidth: 78, color: "rgba(255,255,255,0.62)", fontFamily: fonts.body, fontSize: 10, textAlign: "right" },
  viewerContent: { flex: 1, alignItems: "center", justifyContent: "center", padding: 12 },
  viewerMedia: { flex: 1, width: "100%", alignItems: "center", justifyContent: "center" },
  viewerFallback: { width: "100%", height: "100%" },
  mediaFill: { width: "100%", height: "100%", objectFit: "contain" },
  viewerImage: { width: "100%", height: "100%" },
  viewerVideo: { width: "100%", height: "100%" },
  viewerAudio: { width: "100%", height: 58 },
  playbackError: { position: "absolute", alignSelf: "center", color: "#fff", backgroundColor: "rgba(120,35,42,0.9)", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  audioViewerCard: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.08)" },
  audioViewerIcon: { width: 52, height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(179,164,255,0.16)" },
  audioViewerName: { maxWidth: "82%", color: "#fff", fontFamily: fonts.bodySemibold, fontSize: 13 },
  audioEngine: { position: "absolute", width: 1, height: 1, opacity: 0 },
  viewerTools: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 3 },
  viewerIconButton: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  viewerPrimaryButton: { backgroundColor: colors.primary },
});
