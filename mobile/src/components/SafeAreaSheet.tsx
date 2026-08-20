import type { ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

type Props = {
  onClose: () => void;
  sheetStyle: StyleProp<ViewStyle>;
  children: ReactNode;
};

export function SafeAreaSheet({ onClose, sheetStyle, children }: Props) {
  return <SafeAreaProvider style={styles.provider}><SafeAreaSheetContent onClose={onClose} sheetStyle={sheetStyle}>{children}</SafeAreaSheetContent></SafeAreaProvider>;
}

function SafeAreaSheetContent({ onClose, sheetStyle, children }: Props) {
  const insets = useSafeAreaInsets();
  const flattened = StyleSheet.flatten(sheetStyle);
  const paddingBottom = typeof flattened?.paddingBottom === "number" ? flattened.paddingBottom : 0;

  return <Pressable style={styles.backdrop} onPress={onClose}>
    <Pressable style={[sheetStyle, { paddingBottom: paddingBottom + insets.bottom }]} onPress={(event) => event.stopPropagation()}>
      {children}
    </Pressable>
  </Pressable>;
}

const styles = StyleSheet.create({
  provider: { flex: 1 },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.56)" },
});
