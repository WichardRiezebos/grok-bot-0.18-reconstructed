import { useEffect, useState } from "react";
import { SettingsGroup } from "./computer-view-internals";
import { settingsComputerPhase, useSettingsComputerController, type SettingsComputerMount } from "./computer";
import { SandButton } from "../../../ui/sand-kit-primitives";
import { SandSelect } from "../../../ui/sand-floating-primitives";
import type { BoxRuntimeSnapshot } from "../../../contracts/desktop-bridge";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L523

const UPDATE_COPY = "Updates the computer your assistants share. Your files and logins stay. All assistants update together.";
const UP_TO_DATE_COPY = "Your computer is on the latest version";
const BUSY_COPY = "An agent is working. Updating now will interrupt it.";
const QUEUED_COPY = "Update queued. It runs as soon as every agent is done.";
const BLOCKED_COPY = "Further computer updates and resets are disabled for this session. Restart Grok Bot after the computer is available again.";
const RESET_COPY = "Start fresh if the computer gets stuck. It's rebuilt from your last saved snapshot, so very recent changes may be lost.";
const RESET_UNAVAILABLE_COPY = "Open an agent to reset the shared computer";

const BOX_IDLE_OPTIONS = [
  { value: "0", label: "Off" },
  { value: String(15 * 60_000), label: "15 minutes" },
  { value: String(30 * 60_000), label: "30 minutes" },
  { value: String(60 * 60_000), label: "1 hour" },
  { value: String(2 * 60 * 60_000), label: "2 hours" },
] as const;

const DEFAULT_IDLE_MS = 30 * 60_000;

export function SettingsComputerPanel({ state, actions }: SettingsComputerMount) {
  const phase = settingsComputerPhase(state);
  const controller = useSettingsComputerController(state, actions);
  const updateExtraCopy = state.isRebuildBlocked
    ? BLOCKED_COPY
    : phase === "queued"
      ? QUEUED_COPY
      : phase === "busy-override"
        ? BUSY_COPY
        : null;
  const resetExtraCopy = state.isRebuildBlocked ? BLOCKED_COPY : !state.canResetBox ? RESET_UNAVAILABLE_COPY : null;

  return (
    <SettingsGroup title="Grok Bot's Computer">
      {phase === "up-to-date" && !state.isRebuildBlocked ? (
        <div className="sand-settings-uptodate-banner" role="status">
          <strong>{UP_TO_DATE_COPY}</strong>
          <span>{UPDATE_COPY}</span>
        <SandButton className="sand-settings-reset" disabled={controller.updateDisabled} onClick={controller.requestUpdate} size="md" variant="secondary">{controller.updateLabel}</SandButton>
        </div>
      ) : (
        <SettingsComputerRow
          description={UPDATE_COPY}
          extraCopy={updateExtraCopy}
          label="Update Grok Bot's Computer"
          control={<SandButton className="sand-settings-reset" data-confirming={controller.updateConfirming || undefined} disabled={controller.updateDisabled} onClick={controller.requestUpdate} size="md" variant="secondary">{controller.updateLabel}</SandButton>}
        />
      )}
      {state.isDevBuild ? <SandButton className="sand-settings-force-refresh" disabled={state.isRebuildBlocked || state.isUpdateBoxPending || state.isResetBoxPending} onClick={controller.refreshAnyway} size="md" title="Test the update flow even though the computer is already up to date" variant="secondary">Refresh Anyway</SandButton> : null}
      <SettingsComputerRow
        description={RESET_COPY}
        extraCopy={resetExtraCopy}
        label="Reset Grok Bot's Computer"
        control={<SandButton className="sand-settings-reset" disabled={!state.canResetBox || state.isRebuildBlocked || state.isUpdateBoxPending || state.isResetBoxPending} onClick={controller.requestReset} sentiment="danger" size="md" variant="primary">{state.isResetBoxPending ? "Resetting…" : "Reset"}</SandButton>}
      />
      <SettingsBoxAutoSuspend />
    </SettingsGroup>
  );
}

function SettingsComputerRow({ description, extraCopy, label, control }: { description: string; extraCopy: string | null; label: string; control: React.ReactNode }) {
  return (
    <div className="sand-settings-row">
      <div className="sand-settings-copy">
        <strong>{label}</strong>
        <span className="sand-settings-field__hint">{description}</span>
        {extraCopy ? <span className="sand-settings-field__hint">{extraCopy}</span> : null}
      </div>
      <div className="sand-settings-control">{control}</div>
    </div>
  );
}

function SettingsBoxAutoSuspend() {
  const agent = window.desktop?.agent;
  const [runtime, setRuntime] = useState<BoxRuntimeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<"idle" | "sleep" | "wake" | null>(null);

  useEffect(() => {
    if (agent?.getBoxRuntime == null) return;
    let active = true;
    const refresh = () => {
      void agent.getBoxRuntime!().then((next) => {
        if (active) {
          setRuntime(next);
          setError(null);
        }
      }).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [agent]);

  if (agent?.getBoxRuntime == null || agent.setBoxAutoSuspendIdleMs == null || agent.suspendBox == null || agent.resumeBox == null) return null;
  if (runtime?.mode === "docker") return null;

  const running = runtime?.status?.ready === true || runtime?.status?.running === true;
  const idleMs = typeof runtime?.idleMs === "number" ? runtime.idleMs : DEFAULT_IDLE_MS;
  const sleeping = runtime?.suspended === true || (!running && idleMs > 0);
  const statusLabel = acting === "wake" ? "Starting" : runtime == null ? "Checking…" : runtime.status?.available === false ? "Docker unavailable" : sleeping ? "Sleeping" : running ? "Running" : "Not running";

  const act = async (kind: "idle" | "sleep" | "wake", work: () => Promise<BoxRuntimeSnapshot>) => {
    setActing(kind);
    setError(null);
    try {
      setRuntime(await work());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActing(null);
    }
  };

  return (
    <>
      <SettingsComputerRow
        description={sleeping ? "The local Docker VM is stopped until you wake it or send a message." : (runtime?.status?.detail ?? "Shell, files and computer use run in a local Docker VM on this Mac.")}
        extraCopy={error}
        label="Computer"
        control={<span role="status">{statusLabel}</span>}
      />
      <SettingsComputerRow
        description="Stops the local Docker VM after this much idle time so it is not using CPU and RAM. Sending a message or clicking Wake starts it again."
        extraCopy={null}
        label="Auto-suspend"
        control={
          <SandSelect
            ariaLabel="Auto-suspend idle time"
            className="ui-select-trigger"
            disabled={acting != null}
            onValueChange={(value) => { void act("idle", () => agent.setBoxAutoSuspendIdleMs!(Number(value))); }}
            options={[...BOX_IDLE_OPTIONS]}
            placement="bottom-end"
            value={String(idleMs)}
          />
        }
      />
      <SettingsComputerRow
        description="Sleep stops the VM now. Wake starts it again. Files and logins stay on the Docker volumes."
        extraCopy={null}
        label="Power"
        control={
          <div className="sand-settings-control" style={{ display: "flex", gap: 8 }}>
            <SandButton disabled={acting != null || sleeping || !running} onClick={() => { void act("sleep", () => agent.suspendBox!()); }} size="md" variant="secondary">{acting === "sleep" ? "Sleeping…" : "Sleep now"}</SandButton>
            <SandButton disabled={acting != null || (running && !sleeping)} onClick={() => { void act("wake", () => agent.resumeBox!()); }} size="md" variant="secondary">{acting === "wake" ? "Waking…" : "Wake"}</SandButton>
          </div>
        }
      />
    </>
  );
}
