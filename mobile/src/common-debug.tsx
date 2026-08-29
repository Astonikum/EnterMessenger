import { createContext, useContext, type ReactNode } from "react";

const CommonDebugContext = createContext(false);

export const commonDebugStyle = { borderColor: "#ff3b30", borderWidth: 2 } as const;

export function CommonDebugProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <CommonDebugContext.Provider value={enabled}>{children}</CommonDebugContext.Provider>;
}

export function useCommonDebug() {
  return useContext(CommonDebugContext);
}
