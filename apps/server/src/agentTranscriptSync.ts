/**
 * Real-time transcript sync: tails agent CLI JSONL logs and converts them
 * to AgentMessage format for the IM view.
 *
 * Supported agents:
 * - claude: ~/.claude/projects/<path-slug>/<uuid>.jsonl
 * - codex: ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { EventEmitter } from "node:events";

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

export interface TranscriptSyncEvents {
  sessionStarted: (session: TerminalSession) => void;
  sessionUpdated: (session: TerminalSession) => void;
  sessionEnded: (sessionId: string) => void;
  messageAdded: (sessionId: string, message: SyncedMessage) => void;
}

export class TranscriptSync extends EventEmitter<TranscriptSyncEvents> {
  private sessions = new Map<string, TerminalSession>();
  private watchers = new Map<string, { watcher: fs.FSWatcher; position: number }>();

  /**
   * Start syncing a terminal session. Called when agent activity is detected.
   */
  async startSession(terminalId: string, agent: "claude" | "codex", cwd: string): Promise<void> {
    if (this.sessions.has(terminalId)) {
      return; // Already syncing
    }

    const logPath = await this.findLatestLog(agent, cwd);
    if (!logPath) {
      console.warn(`[TranscriptSync] No log file found for ${agent} in ${cwd}`);
      return;
    }

    const sessionId = path.basename(logPath, ".jsonl").replace("rollout-", "");
    const session: TerminalSession = {
      id: terminalId,
      sessionId,
      agent,
      cwd,
      messages: [],
      status: "working",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(terminalId, session);
    this.emit("sessionStarted", session);

    // Start tailing the log file
    await this.startTailing(terminalId, logPath, agent);
  }

  /**
   * Stop syncing a terminal session. Called when agent exits.
   */
  stopSession(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    const watcher = this.watchers.get(terminalId);
    if (watcher) {
      watcher.watcher.close();
      this.watchers.delete(terminalId);
    }

    session.status = "done";
    session.updatedAt = Date.now();
    this.emit("sessionEnded", terminalId);
    this.sessions.delete(terminalId);
  }

  /**
   * Get current session state.
   */
  getSession(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  /**
   * Get all active sessions.
   */
  getAllSessions(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Find the latest log file for an agent in a given cwd.
   */
  private async findLatestLog(agent: "claude" | "codex", cwd: string): Promise<string | null> {
    if (agent === "claude") {
      return this.findLatestClaudeLog(cwd);
    } else if (agent === "codex") {
      return this.findLatestCodexLog();
    }
    return null;
  }

  private async findLatestClaudeLog(cwd: string): Promise<string | null> {
    const root = path.join(os.homedir(), ".claude", "projects");
    try {
      const projectDirs = await fs.promises.readdir(root, { withFileTypes: true });
      const now = Date.now();
      let latest: { path: string; mtime: number } | null = null;

      for (const dirent of projectDirs) {
        if (!dirent.isDirectory()) continue;
        const projDir = path.join(root, dirent.name);
        try {
          const files = await fs.promises.readdir(projDir);
          for (const file of files) {
            if (!/^[0-9a-f][0-9a-f-]{34}[0-9a-f]\.jsonl$/.test(file)) continue;
            const filePath = path.join(projDir, file);
            const stat = await fs.promises.stat(filePath);
            // Only consider files modified in the last 5 minutes
            if (now - stat.mtimeMs < 5 * 60 * 1000) {
              if (!latest || stat.mtimeMs > latest.mtime) {
                latest = { path: filePath, mtime: stat.mtimeMs };
              }
            }
          }
        } catch {
          // Project dir vanished
        }
      }

      return latest?.path ?? null;
    } catch {
      return null;
    }
  }

  private async findLatestCodexLog(): Promise<string | null> {
    const root = path.join(os.homedir(), ".codex", "sessions");
    try {
      const files = await fs.promises.readdir(root, { recursive: true });
      const now = Date.now();
      let latest: { path: string; mtime: number } | null = null;

      for (const file of files) {
        if (typeof file !== "string" || !/rollout-.*\.jsonl$/.test(file)) continue;
        const filePath = path.join(root, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (now - stat.mtimeMs < 5 * 60 * 1000) {
            if (!latest || stat.mtimeMs > latest.mtime) {
              latest = { path: filePath, mtime: stat.mtimeMs };
            }
          }
        } catch {
          // File vanished
        }
      }

      return latest?.path ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Start tailing a log file.
   */
  private async startTailing(terminalId: string, logPath: string, agent: "claude" | "codex"): Promise<void> {
    const stat = await fs.promises.stat(logPath);
    const watcher = fs.createReadStream(logPath, {
      start: stat.size, // Start from current end
      encoding: "utf8",
    });

    let buffer = "";
    this.watchers.set(terminalId, { watcher: watcher as any, position: stat.size });

    watcher.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          this.processLogEntry(terminalId, entry, agent);
        } catch {
          // Ignore parse errors (incomplete line)
        }
      }
    });

    watcher.on("error", (err: Error) => {
      console.error(`[TranscriptSync] Watcher error for ${terminalId}:`, err);
      this.stopSession(terminalId);
    });

    watcher.on("end", () => {
      // File closed, but agent might still be running
      // Keep session alive for a bit
    });
  }

  /**
   * Process a single log entry.
   */
  private processLogEntry(terminalId: string, entry: any, agent: "claude" | "codex"): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;

    if (agent === "claude") {
      this.processClaudeEntry(session, entry);
    } else if (agent === "codex") {
      this.processCodexEntry(session, entry);
    }

    session.updatedAt = Date.now();
    this.emit("sessionUpdated", session);
  }

  private processClaudeEntry(session: TerminalSession, entry: any): void {
    // Skip metadata entries
    if (entry.type === "mode" || entry.type === "file-history-snapshot" || entry.type === "attachment") {
      return;
    }

    // User message
    if (entry.type === "user" && !entry.isMeta) {
      const content = entry.message?.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        // Could be tool_result or text
        const textPart = content.find((c: any) => c?.type === "text" && typeof c.text === "string");
        if (textPart) {
          text = textPart.text;
        } else {
          // Tool result - skip for now
          return;
        }
      }

      if (text && !text.startsWith("<")) {
        const message: SyncedMessage = {
          id: entry.uuid || crypto.randomUUID(),
          role: "user",
          content: text.trim(),
          createdAt: new Date(entry.timestamp).getTime(),
        };
        session.messages.push(message);
        this.emit("messageAdded", session.id, message);
      }
    }

    // Assistant message
    if (entry.type === "assistant") {
      const content = entry.message?.content;
      if (!Array.isArray(content)) return;

      let text = "";
      const parts: SyncedPart[] = [];
      let tokens: SyncedMessage["tokens"] | undefined;

      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
          parts.push({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const toolPart: SyncedPart = {
            kind: "tool",
            id: block.id,
            title: block.name,
            input: JSON.stringify(block.input, null, 2),
          };
          parts.push(toolPart);
        } else if (block.type === "thinking") {
          // Skip thinking for now
        }
      }

      // Extract token usage
      const usage = entry.message?.usage;
      if (usage) {
        tokens = {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
          cacheWrite: usage.cache_creation_input_tokens || 0,
        };
      }

      if (text || parts.length > 0) {
        const message: SyncedMessage = {
          id: entry.message?.id || entry.uuid || crypto.randomUUID(),
          role: "assistant",
          content: text.trim(),
          createdAt: new Date(entry.timestamp).getTime(),
          parts: parts.length > 0 ? parts : undefined,
          tokens,
        };
        session.messages.push(message);
        this.emit("messageAdded", session.id, message);
      }
    }
  }

  private processCodexEntry(session: TerminalSession, entry: any): void {
    // Skip metadata and events
    if (entry.type !== "response_item") return;

    const payload = entry.payload;
    if (!payload || payload.type !== "message") return;

    const role = payload.role;
    if (role !== "user" && role !== "assistant") return;

    const content = payload.content;
    if (!Array.isArray(content)) return;

    let text = "";
    const parts: SyncedPart[] = [];

    for (const block of content) {
      if (block.type === "input_text" && typeof block.text === "string") {
        text += block.text;
        parts.push({ kind: "text", text: block.text });
      } else if (block.type === "output_text" && typeof block.text === "string") {
        text += block.text;
        parts.push({ kind: "text", text: block.text });
      } else if (block.type === "tool_call") {
        const toolPart: SyncedPart = {
          kind: "tool",
          id: block.id || crypto.randomUUID(),
          title: block.name || "tool",
          input: block.arguments ? JSON.stringify(JSON.parse(block.arguments), null, 2) : undefined,
        };
        parts.push(toolPart);
      }
    }

    if (text && !text.startsWith("<")) {
      const message: SyncedMessage = {
        id: payload.id || crypto.randomUUID(),
        role: role as "user" | "assistant",
        content: text.trim(),
        createdAt: new Date(entry.timestamp).getTime(),
        parts: parts.length > 0 ? parts : undefined,
      };
      session.messages.push(message);
      this.emit("messageAdded", session.id, message);
    }
  }
}

// Singleton instance
let instance: TranscriptSync | null = null;

export function getTranscriptSync(): TranscriptSync {
  if (!instance) {
    instance = new TranscriptSync();
  }
  return instance;
}
