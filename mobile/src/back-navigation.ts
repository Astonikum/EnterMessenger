import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";
import { createBackActionRegistry, type BackAction, type BackActionRegistry } from "../../common/src/navigation.ts";

export { createBackActionRegistry };
export type { BackAction, BackActionRegistry };

const BackNavigationContext = createContext<BackActionRegistry | null>(null);

export function BackNavigationProvider({ registry, children }: { registry: BackActionRegistry; children: ReactNode }) {
  return createElement(BackNavigationContext.Provider, { value: registry }, children);
}

export function useBackAction(action: BackAction, enabled = true) {
  const registry = useContext(BackNavigationContext);
  const actionRef = useRef(action);
  actionRef.current = action;
  if (!registry) throw new Error("useBackAction must be used inside BackNavigationProvider");
  useEffect(() => {
    if (!enabled) return undefined;
    return registry.register(() => actionRef.current());
  }, [enabled, registry]);
}
