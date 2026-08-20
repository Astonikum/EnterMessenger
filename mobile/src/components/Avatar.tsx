import { useId } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, G, Mask, Path, Rect } from "react-native-svg";
import { colors, fonts } from "../theme";
import type { Conversation } from "../types";
import { Icon } from "./Icon";

const avatarColors = ["#ff3b30", "#ffd60a", "#30d158", "#0a84ff", "#bf5af2", "#ff375f", "#ff9f0a", "#ffffff"];

function hash(value: string) {
  let result = 0;
  for (const character of value) {
    result = (result << 5) - result + character.charCodeAt(0);
    result |= 0;
  }
  return Math.abs(result);
}

function digit(value: number, position: number) {
  return Math.floor(value / 10 ** position) % 10;
}

function signed(value: number, modulo: number, position?: number) {
  const result = value % modulo;
  return position && digit(value, position) % 2 === 0 ? -result : result;
}

function palette(value: number) {
  return avatarColors[value % avatarColors.length];
}

function isDark(color: string) {
  const hex = color.slice(1);
  const luminance = (299 * parseInt(hex.slice(0, 2), 16) + 587 * parseInt(hex.slice(2, 4), 16) + 114 * parseInt(hex.slice(4, 6), 16)) / 1000;
  return luminance < 128;
}

function BeamAvatar({ name, size }: { name: string; size: number }) {
  const seed = hash(name);
  const wrapperBaseX = signed(seed, 10, 1);
  const wrapperTranslateX = wrapperBaseX < 5 ? wrapperBaseX + 4 : wrapperBaseX;
  const wrapperBaseY = signed(seed, 10, 2);
  const wrapperTranslateY = wrapperBaseY < 5 ? wrapperBaseY + 4 : wrapperBaseY;
  const wrapperColor = palette(seed);
  const faceColor = isDark(wrapperColor) ? "#FFFFFF" : "#000000";
  const maskId = `beam-${useId().replace(/:/g, "")}`;
  const faceTranslateX = wrapperTranslateX > 6 ? wrapperTranslateX / 2 : signed(seed, 8, 1);
  const faceTranslateY = wrapperTranslateY > 6 ? wrapperTranslateY / 2 : signed(seed, 7, 2);

  return (
    <Svg width={size} height={size} viewBox="0 0 36 36" fill="none">
      <Defs>
        <Mask id={maskId} x="0" y="0" width="36" height="36">
          <Rect width="36" height="36" rx="18" fill="#FFFFFF" />
        </Mask>
      </Defs>
      <G mask={`url(#${maskId})`}>
        <Rect width="36" height="36" fill={palette(seed + 13)} />
        <Rect
          x="0"
          y="0"
          width="36"
          height="36"
          rx={digit(seed, 1) % 2 === 0 ? 36 : 6}
          fill={wrapperColor}
          transform={`translate(${wrapperTranslateX} ${wrapperTranslateY}) rotate(${signed(seed, 360)} 18 18) scale(${1 + signed(seed, 3) / 10})`}
        />
        <G transform={`translate(${faceTranslateX} ${faceTranslateY}) rotate(${signed(seed, 10, 3)} 18 18)`}>
          {digit(seed, 2) % 2 === 0 ? (
            <Path d={`M15 ${19 + signed(seed, 3)}c2 1 4 1 6 0`} stroke={faceColor} fill="none" strokeLinecap="round" />
          ) : (
            <Path d={`M13,${19 + signed(seed, 3)} a1,0.75 0 0,0 10,0`} fill={faceColor} />
          )}
          <Rect x={14 - signed(seed, 5)} y="14" width="1.5" height="2" rx="1" fill={faceColor} />
          <Rect x={20 + signed(seed, 5)} y="14" width="1.5" height="2" rx="1" fill={faceColor} />
        </G>
      </G>
    </Svg>
  );
}

export function ProfileAvatar({ name, size = 44 }: { name: string; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, overflow: "hidden" }]}>
      <BeamAvatar name={name.replace(/^@/, "")} size={size} />
    </View>
  );
}

export function ConversationAvatar({ conversation, size = 48 }: { conversation: Pick<Conversation, "id" | "handle" | "avatar" | "name">; size?: number }) {
  if (conversation.handle === "favorites" || conversation.avatar === "favorites") {
    return <View style={[styles.avatar, styles.favorites, { width: size, height: size, borderRadius: size / 2 }]}><Icon name="star" size={size * 0.48} color={colors.primaryText} /></View>;
  }
  if (conversation.handle === "official" || conversation.avatar === "enter-official") {
    return <View style={[styles.avatar, styles.official, { width: size, height: size, borderRadius: size / 2 }]}><Text style={[styles.officialLetter, { fontSize: size * 0.48 }]}>E</Text></View>;
  }
  return <ProfileAvatar name={conversation.name} size={size} />;
}

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center" },
  favorites: { backgroundColor: colors.primary },
  official: { backgroundColor: "#352b65" },
  officialLetter: { color: colors.primary, fontFamily: fonts.headingBold },
});
