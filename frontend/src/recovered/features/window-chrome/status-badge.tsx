import "./status-badge.css";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L21263
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L56784

export type WindowTransportState = "browser" | "connecting" | "connected" | "down" | "reconnecting" | "unhealthy";
type StatusDotState = "working" | "info" | "offline";

interface StatusBadgeState {
  dot: StatusDotState;
  label: "Connecting" | "Connected" | "Disconnected" | "Reconnecting" | "Unhealthy";
}

const STATUS_BY_TRANSPORT: Record<Exclude<WindowTransportState, "browser">, StatusBadgeState> = {
  connecting: { dot: "working", label: "Connecting" },
  connected: { dot: "info", label: "Connected" },
  down: { dot: "offline", label: "Disconnected" },
  reconnecting: { dot: "working", label: "Reconnecting" },
  unhealthy: { dot: "offline", label: "Unhealthy" },
};

export function WindowStatusBadge({ isFullscreen, transport }: { isFullscreen: boolean; transport: WindowTransportState }) {
  if (isFullscreen || transport === "browser") return null;
  const state = STATUS_BY_TRANSPORT[transport];
  return <span aria-label={state.label} className="sand-kit-status-dot" data-status={state.dot} role="status" />;
}
