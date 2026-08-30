export const PRESENCE_HEARTBEAT_TIMEOUT_MS = 45_000;

export type PresenceInputs = {
  appActive: boolean;
  visible: boolean;
  focused: boolean;
  networkOnline: boolean;
  realtimeReady: boolean;
  lastHeartbeatAt: number | null;
};

export type PresenceState = "background" | "offline" | "connecting" | "online" | "stale";

export function shouldKeepPresenceConnection(input: PresenceInputs) {
  return input.appActive && input.visible && input.focused && input.networkOnline;
}

export function derivePresenceState(input: PresenceInputs, now = Date.now(), heartbeatTimeout = PRESENCE_HEARTBEAT_TIMEOUT_MS): PresenceState {
  if (!input.appActive || !input.visible || !input.focused) return "background";
  if (!input.networkOnline) return "offline";
  if (!input.realtimeReady) return "connecting";
  if (input.lastHeartbeatAt === null || now - input.lastHeartbeatAt > heartbeatTimeout) return "stale";
  return "online";
}

export function createPresenceStateMachine(initial: PresenceInputs) {
  let inputs = { ...initial };
  let state = derivePresenceState(inputs);

  return {
    getInputs: () => ({ ...inputs }),
    getState: () => state,
    update(patch: Partial<PresenceInputs>, now = Date.now()) {
      const previous = state;
      inputs = { ...inputs, ...patch };
      state = derivePresenceState(inputs, now);
      return { previous, current: state, changed: previous !== state };
    },
  };
}
