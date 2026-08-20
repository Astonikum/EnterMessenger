type RealtimeLifecycleHooks = {
  onActive: () => void;
  onInactive: () => void;
};

function isActive(state: string | null) {
  return state === null || state === "active";
}

export function createRealtimeLifecycle(initialState: string | null, hooks: RealtimeLifecycleHooks) {
  let active = isActive(initialState);
  let stopped = false;

  return {
    start() {
      if (!stopped && active) hooks.onActive();
    },
    change(state: string | null) {
      if (stopped) return;
      const nextActive = isActive(state);
      if (nextActive === active) return;
      active = nextActive;
      if (active) hooks.onActive();
      else hooks.onInactive();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      hooks.onInactive();
    },
    isActive() {
      return active && !stopped;
    },
  };
}
