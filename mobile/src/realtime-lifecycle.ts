import { createPresenceLifecycle } from "../../common/src/presence-lifecycle.ts";

type RealtimeLifecycleHooks = {
  onActive: () => void;
  onInactive: () => void;
};

function isActive(state: string | null) {
  return state === null || state === "active";
}

export function createRealtimeLifecycle(initialState: string | null, hooks: RealtimeLifecycleHooks) {
  const lifecycle = createPresenceLifecycle(isActive(initialState), { onForeground: hooks.onActive, onBackground: hooks.onInactive });
  return {
    start: lifecycle.start,
    change(state: string | null) {
      lifecycle.setForeground(isActive(state));
    },
    stop: lifecycle.stop,
    isActive: lifecycle.isForeground,
  };
}
