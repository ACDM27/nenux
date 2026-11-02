import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ImMessage } from "@termany/core";
import type { ImService } from "./imService.js";
import type { ImTask, ImTaskStep, ImExecutionSettings } from "@termany/core";
export type { ImTask, ImTaskStatus, ImTaskStep, ImExecutionSettings } from "@termany/core";

export interface ImTaskExecution {
  task: ImTask; settings: ImExecutionSettings; message: ImMessage; signal: AbortSignal;
  progress: (steps: ImTaskStep[]) => void;
  checkpoint?: {
    load: (key: string) => { output: string; taskId: string } | null;
    save: (key: string, output: string) => void;
  };
}

/** One durable queue owns executions. Serial execution also prevents project write races. */
export class ImTaskService {
  private active?: { id: string; controller: AbortController };
  private stopped = false;
  private scheduled = false;
  private resolvedPermissions = new Set<string>();
  constructor(private db: DatabaseSync, private im: ImService, private options: {
    defaultCwd: string;
    execute: (execution: ImTaskExecution) => Promise<number | null>;
    autoStart?: boolean;
  }) {
    db.exec(`CREATE TABLE IF NOT EXISTS im_task (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, trigger_message_id INTEGER NOT NULL,
      parent_task_id TEXT, attempt INTEGER NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT,
      result_message_id INTEGER, steps TEXT NOT NULL DEFAULT '[]',
      UNIQUE(trigger_message_id, attempt));
      CREATE TABLE IF NOT EXISTS im_execution_settings (conversation_id TEXT PRIMARY KEY, settings TEXT NOT NULL);`);
    db.exec(`CREATE TABLE IF NOT EXISTS im_task_checkpoint (
      task_id TEXT NOT NULL, checkpoint_key TEXT NOT NULL, output TEXT NOT NULL,
      PRIMARY KEY (task_id, checkpoint_key));`);
    const columns = db.prepare("PRAGMA table_info(im_task)").all() as { name: string }[];
    if (!columns.some(column => column.name === "execution_settings")) db.exec("ALTER TABLE im_task ADD COLUMN execution_settings TEXT NOT NULL DEFAULT '{}'");
    for (const row of db.prepare("SELECT id FROM im_task WHERE status='running'").all() as { id: string }[]) {
      const task = this.get(row.id)!;
      const reason = "服务重启中断，请检查已完成步骤后重试";
      this.update(task.id, { status: "failed", error: reason, steps: task.steps.map(step =>
        step.status === "running" ? { ...step, status: "failed", error: reason, permission: undefined } : step) });
    }
    if (options.autoStart !== false) this.wake();
  }
  get(id: string): ImTask | null {
    const row = this.db.prepare("SELECT id, conversation_id AS conversationId, trigger_message_id AS triggerMessageId, parent_task_id AS parentTaskId, attempt, status, created_at AS createdAt, updated_at AS updatedAt, error, result_message_id AS resultMessageId, steps, execution_settings FROM im_task WHERE id=?").get(id) as any;
    if (!row) return null;
    const { execution_settings, ...task } = row;
    const saved = JSON.parse(execution_settings);
    return { ...task, steps: JSON.parse(row.steps), executionSettings: saved.cwd ? saved : undefined };
  }
  list(conversationId: string): ImTask[] {
    return (this.db.prepare("SELECT id FROM im_task WHERE conversation_id=? ORDER BY created_at DESC LIMIT 100").all(conversationId) as { id: string }[])
      .map(row => this.get(row.id)!);
  }
  settings(conversationId: string): ImExecutionSettings {
    const row = this.db.prepare("SELECT settings FROM im_execution_settings WHERE conversation_id=?").get(conversationId) as { settings: string } | undefined;
    return row ? JSON.parse(row.settings) : { cwd: this.options.defaultCwd, maxTurns: 12, timeoutMs: 300_000 };
  }
  configure(conversationId: string, settings: ImExecutionSettings): void {
    if (!settings || typeof settings.cwd !== "string" || !settings.cwd.trim()) throw new Error("project directory is required");
    const cwd = resolve(settings.cwd);
    try { if (!statSync(cwd).isDirectory()) throw new Error(); }
    catch { throw new Error("project directory does not exist or is not a directory"); }
    if (settings.leadAgentId && !this.im.listMembers(conversationId).some(member => member.memberType === "bot" && member.userOrBotId === settings.leadAgentId)) throw new Error("lead agent must be a conversation Bot");
    if (!Number.isInteger(settings.maxTurns) || settings.maxTurns < 1 || settings.maxTurns > 24) throw new Error("maxTurns must be 1–24");
    if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 1_800_000) throw new Error("timeoutMs must be 1000–1800000");
    this.db.prepare("INSERT INTO im_execution_settings VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET settings=excluded.settings")
      .run(conversationId, JSON.stringify({ ...settings, cwd }));
  }
  enqueue(message: ImMessage, parentTaskId: string | null = null): ImTask | null {
    if (message.senderType !== "user" || message.role !== "user") return null;
    if (!this.im.listMembers(message.conversationId).some(member => member.memberType === "bot")) return null;
    const previous = (this.db.prepare("SELECT id FROM im_task WHERE trigger_message_id=? ORDER BY attempt DESC").all(message.id) as { id: string }[]).map(row => this.get(row.id)!);
    if (!parentTaskId && previous.length) return previous[0];
    if (previous.some(task => task.status === "queued" || task.status === "running")) throw new Error("task is already active");
    const task: ImTask = { id: randomUUID(), conversationId: message.conversationId, triggerMessageId: message.id,
      parentTaskId, attempt: Math.max(0, ...previous.map(task => task.attempt)) + 1, status: "queued",
      createdAt: Date.now(), updatedAt: Date.now(), error: null, resultMessageId: null, steps: [],
      executionSettings: (parentTaskId ? this.get(parentTaskId)?.executionSettings : undefined) || message.metadata.handoffExecution || this.settings(message.conversationId) };
    this.db.prepare("INSERT INTO im_task (id, conversation_id, trigger_message_id, parent_task_id, attempt, status, created_at, updated_at, execution_settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.conversationId, message.id, parentTaskId, task.attempt, task.status, task.createdAt, task.updatedAt, JSON.stringify(task.executionSettings));
    this.event(task);
    this.wake();
    return task;
  }
  private message(task: ImTask): ImMessage {
    const page = this.im.getMessages(task.conversationId, { beforeSeq: Number.MAX_SAFE_INTEGER, limit: 100 });
    let items = page.items;
    let cursor = page.nextCursor;
    while (!items.some(message => message.id === task.triggerMessageId) && cursor !== null) {
      const next = this.im.getMessages(task.conversationId, { beforeSeq: cursor, limit: 100 });
      items = next.items; cursor = next.nextCursor;
    }
    const message = items.find(message => message.id === task.triggerMessageId);
    if (!message) throw new Error("trigger message not found or withdrawn");
    return message;
  }
  retry(id: string): ImTask {
    const task = this.get(id);
    if (!task) throw new Error("task not found");
    if (!["failed", "cancelled"].includes(task.status)) throw new Error("only failed or cancelled tasks can retry");
    return this.enqueue(this.message(task), id)!;
  }
  cancel(id: string): void {
    const task = this.get(id);
    if (!task) throw new Error("task not found");
    if (!["queued", "running"].includes(task.status)) return;
    this.update(id, { status: "cancelled", error: "用户取消", steps: task.steps.map(step =>
      step.status === "running" ? { ...step, status: "failed", error: "用户取消", permission: undefined } : step) });
    if (this.active?.id === id) this.active.controller.abort(new Error("用户取消"));
  }
  respondPermission(id: string, requestId: string, optionId: string, respond: (paneId: string, requestId: string, optionId: string) => boolean): void {
    const task = this.get(id);
    if (!task || task.status !== "running") throw new Error("active task not found");
    const step = task.steps.find(item => item.permission?.requestId === requestId);
    const permission = step?.permission;
    if (!permission || !permission.options.some(option => option.optionId === optionId)) throw new Error("permission request not found");
    if (!respond(permission.paneId, requestId, optionId)) throw new Error("permission request expired");
    this.resolvedPermissions.add(requestId);
    delete step!.permission;
    this.update(id, { steps: task.steps });
  }
  private event(task: ImTask) {
    const now = Date.now();
    this.db.prepare("INSERT INTO im_event_outbox (event_id, channel, event_type, payload, status, created_at, updated_at) VALUES (?, ?, 'im.task.updated', ?, 'pending', ?, ?)")
      .run(randomUUID(), `conversation:${task.conversationId}`, JSON.stringify({ taskId: task.id, conversationId: task.conversationId }), now, now);
  }
  private update(id: string, patch: Partial<ImTask>): void {
    const task = this.get(id);
    if (!task) return;
    const next = { ...task, ...patch, updatedAt: Date.now() };
    this.db.prepare("UPDATE im_task SET status=?, updated_at=?, error=?, result_message_id=?, steps=? WHERE id=?")
      .run(next.status, next.updatedAt, next.error, next.resultMessageId, JSON.stringify(next.steps), id);
    this.event(next);
  }
  wake(): void {
    if (this.stopped || this.scheduled || this.active) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; if (!this.stopped) void this.drain(); });
  }
  private async drain(): Promise<void> {
    if (this.stopped || this.active) return;
    const row = this.db.prepare("SELECT id FROM im_task WHERE status='queued' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    if (!row) return;
    const controller = new AbortController();
    this.active = { id: row.id, controller };
    const task = this.get(row.id)!;
    const settings = task.executionSettings || this.settings(task.conversationId);
    this.update(task.id, { status: "running" });
    const timeout = setTimeout(() => controller.abort(new Error("执行超时")), settings.timeoutMs);
    try {
      const resultMessageId = await this.options.execute({ task, settings, message: this.message(task), signal: controller.signal,
        checkpoint: {
          load: key => {
            let ancestor = task.parentTaskId;
            const seen = new Set<string>();
            while (ancestor && !seen.has(ancestor)) {
              seen.add(ancestor);
              const saved = this.db.prepare("SELECT output FROM im_task_checkpoint WHERE task_id=? AND checkpoint_key=?").get(ancestor, key) as { output: string } | undefined;
              if (saved) return { output: saved.output, taskId: ancestor };
              ancestor = this.get(ancestor)?.parentTaskId || null;
            }
            return null;
          },
          save: (key, output) => {
            controller.signal.throwIfAborted();
            this.db.prepare("INSERT OR IGNORE INTO im_task_checkpoint VALUES (?, ?, ?)").run(task.id, key, output);
          },
        },
        progress: steps => {
          for (const step of steps) {
            if (step.permission && this.resolvedPermissions.has(step.permission.requestId)) delete step.permission;
          }
          if (!controller.signal.aborted) this.update(task.id, { steps });
        } });
      controller.signal.throwIfAborted();
      this.update(task.id, { status: "succeeded", resultMessageId });
    } catch (error) {
      const current = this.get(task.id);
      if (current?.status !== "cancelled") {
        const cause = controller.signal.aborted ? controller.signal.reason : error;
        const reason = String(cause instanceof Error ? cause.message : cause);
        this.update(task.id, { status: "failed", error: reason, steps: current?.steps.map(step =>
          step.status === "running" ? { ...step, status: "failed", error: reason, permission: undefined } : step) });
      }
    } finally {
      clearTimeout(timeout);
      this.active = undefined;
      this.wake();
    }
  }
  stop(): void { this.stopped = true; this.active?.controller.abort(new Error("服务停止")); }
}
