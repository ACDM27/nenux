/**
 * Hook to subscribe to terminal transcript sync SSE events.
 * Provides real-time updates for terminal sessions running agents.
 */
import { useEffect, useState, useCallback } from "react";
import { apiPath } from "./api";

export interface SyncedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  parts?: SyncedPart[];
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export type SyncedPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; title: string; status?: string; input?: string; output?: string };

export interface TerminalSession {
  id: string;
  sessionId: string;
  agent: "claude" | "codex";
  cwd: string;
  messages: SyncedMessage[];
  status: "working" | "done" | "error";
  startedAt: number;
  updatedAt: number;
}

interface TranscriptSyncPayload {
  sessions: TerminalSession[];
}

let cachedSessions: TerminalSession[] = [];
let listeners: Array<(sessions: TerminalSession[]) => void> = [];

function notifyListeners() {
  for (const listener of listeners) {
    listener(cachedSessions);
  }
}

export function useTerminalTranscriptSync() {
  const [sessions, setSessions] = useState<TerminalSession[]>(cachedSessions);

  useEffect(() => {
    // Subscribe to SSE events
    const eventSource = new EventSource(apiPath("/transcript/events"));

    eventSource.addEventListener("transcript", (event) => {
      try {
        const payload: TranscriptSyncPayload = JSON.parse((event as MessageEvent).data);
        cachedSessions = payload.sessions;
        setSessions(payload.sessions);
        notifyListeners();
      } catch (err) {
        console.error("[TranscriptSync] Failed to parse SSE event:", err);
      }
    });

    eventSource.onerror = () => {
      console.warn("[TranscriptSync] SSE connection error, will retry...");
    };

    // Add listener
    listeners.push(setSessions);

    return () => {
      eventSource.close();
      listeners = listeners.filter((l) => l !== setSessions);
    };
  }, []);

  const getSession = useCallback((terminalId: string) => {
    return sessions.find((s) => s.id === terminalId);
  }, [sessions]);

  return {
    sessions,
    getSession,
  };
}

/**
 * Get all terminal sessions (for use outside React components).
 */
export function getTerminalSessions(): TerminalSession[] {
  return cachedSessions;
}
