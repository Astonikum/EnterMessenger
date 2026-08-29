export type ThemeColors = {
  background: string;
  surface: string;
  surfaceRaised: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  primary: string;
  primaryText: string;
  danger: string;
  success: string;
};

export const colors: ThemeColors = {
  background: "#121212",
  surface: "#1b1b1b",
  surfaceRaised: "#222222",
  foreground: "#f0f0f0",
  muted: "#a3a3a3",
  border: "#303030",
  accent: "#3d326e",
  primary: "#b3a4ff",
  primaryText: "#17131f",
  danger: "#ff625e",
  success: "#30d158",
};

const accentColors: Record<"violet" | "blue" | "green" | "rose", { primary: string; primaryText: string; accent: string }> = {
  violet: { primary: "#b3a4ff", primaryText: "#17131f", accent: "#3d326e" },
  blue: { primary: "#64b5ff", primaryText: "#07131f", accent: "#193e61" },
  green: { primary: "#65d993", primaryText: "#07170d", accent: "#1d5436" },
  rose: { primary: "#ff8cac", primaryText: "#210b13", accent: "#64253e" },
};

export function makeThemeColors(theme: "system" | "light" | "dark", accent: keyof typeof accentColors, systemScheme?: "light" | "dark" | null): ThemeColors {
  const dark = theme === "dark" || (theme === "system" && systemScheme !== "light");
  const accentSet = accentColors[accent];
  return dark
    ? { ...colors, ...accentSet }
    : {
        ...colors,
        background: "#f5f5f7",
        surface: "#ffffff",
        surfaceRaised: "#eef0f4",
        foreground: "#17181c",
        muted: "#686d78",
        border: "#d9dce3",
        ...accentSet,
      };
}

export const fonts = {
  body: "IBMPlexSans-Regular",
  bodyMedium: "IBMPlexSans-Medium",
  bodySemibold: "IBMPlexSans-SemiBold",
  bodyBold: "IBMPlexSans-Bold",
  headingMedium: "Montserrat-Medium",
  headingSemibold: "Montserrat-SemiBold",
  headingBold: "Montserrat-Bold",
} as const;

export const radii = {
  sm: 10,
  md: 14,
  lg: 20,
  pill: 999,
};
