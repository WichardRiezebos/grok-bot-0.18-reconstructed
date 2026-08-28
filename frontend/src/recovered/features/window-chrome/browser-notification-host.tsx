import { useEffect, useRef } from "react";
import {
  SandBrowserNotificationManager,
  isBrowserNotificationRuntime,
  isBrowserNotificationSupported,
  toNotificationAgentFromRoster,
  toNotificationAgentsFromRoster
} from "./browser-notifications";

export interface BrowserNotificationClient {
  subscribe(family: string, listener: (payload: unknown) => void): () => void;
}

export interface BrowserNotificationHostProps {
  client: BrowserNotificationClient | null;
  openAgent(agentId: string): void | Promise<unknown>;
}

export function BrowserNotificationHost({ client, openAgent }: BrowserNotificationHostProps) {
  const openAgentRef = useRef(openAgent);
  openAgentRef.current = openAgent;

  useEffect(() => {
    if (client == null || !isBrowserNotificationRuntime() || !isBrowserNotificationSupported()) return;
    const manager = new SandBrowserNotificationManager({
      isSupported: () => isBrowserNotificationSupported(),
      isPermissionGranted: () => Notification.permission === "granted",
      isWindowFocused: () => typeof document !== "undefined" && document.hasFocus(),
      createNotification: ({ title, body, silent }) => new Notification(title, { body, silent }),
      openAgent: (agentId) => {
        window.focus();
        void openAgentRef.current(agentId);
      }
    });
    const stopAgents = client.subscribe("agents", (value) => {
      manager.handleAgentsEvent(toNotificationAgentsFromRoster(value));
    });
    const stopUpsert = client.subscribe("agent-upserted", (value) => {
      const agent = toNotificationAgentFromRoster(value);
      if (agent != null) manager.handleAgentUpsertedEvent(agent);
    });
    return () => {
      stopAgents();
      stopUpsert();
      manager.reset();
    };
  }, [client]);

  return null;
}
