/**
 * IM 事件 Outbox Worker
 *
 * 参考 TabTin im_outbox_service.py 的设计：
 * - 每 500ms 轮询一次 im_event_outbox 表
 * - claim 模式：SELECT ... WHERE status IN ('pending','retry') LIMIT N
 * - 投递到 WebSocket 广播（通过回调注入）
 * - 成功 → delivered，失败 → retry（指数退避），8 次后 dead
 * - 租约机制：claim 后 30s 未完成自动释放
 *
 * node:sqlite 不支持 FOR UPDATE SKIP LOCKED，
 * 所以用 JS 层的 claim_token + lease_expires_at 模拟租约。
 */

import type { ImService } from "./imService.js";

export interface OutboxWorkerOptions {
  /** IM 服务实例 */
  imService: ImService;
  /** 事件投递回调：将事件广播到 WebSocket channel */
  deliver: (channel: string, eventType: string, payload: string) => Promise<void>;
  /** 轮询间隔（ms），默认 500 */
  pollIntervalMs?: number;
  /** 每批处理数量，默认 10 */
  batchSize?: number;
}

export class OutboxWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** 防止重叠 tick：上一次投递尚未完成时跳过本轮 */
  private processing = false;
  private deliver: (channel: string, eventType: string, payload: string) => Promise<void>;
  private imService: ImService;
  private pollIntervalMs: number;
  private batchSize: number;
  /** 清理计数器：每 CLEANUP_EVERY_TICKS 轮清理一次已投递事件 */
  private tickCount = 0;
  private static readonly CLEANUP_EVERY_TICKS = 600; // ~5 分钟（500ms × 600）
  private static readonly CLEANUP_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

  constructor(opts: OutboxWorkerOptions) {
    this.imService = opts.imService;
    this.deliver = opts.deliver;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.batchSize = opts.batchSize ?? 10;
  }

  /** 启动 Worker */
  start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
    console.log(`[Outbox] Worker started (poll=${this.pollIntervalMs}ms, batch=${this.batchSize})`);
  }

  /** 停止 Worker */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[Outbox] Worker stopped");
  }

  /** 单次 tick：claim → deliver → mark。重入保护：上一次未完成则跳过 */
  private async tick(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;

    try {
      const events = this.imService.claimOutboxEvents(this.batchSize);
      if (events.length === 0) {
        // 无事件时也算一轮，推进清理计数
        this.tickCount++;
      } else {
        // 并行投递，各自独立处理成功/失败
        await Promise.allSettled(
          events.map(async (event) => {
            try {
              await this.deliver(event.channel, event.eventType, event.payload);
              this.imService.markOutboxDelivered(event.eventId);
            } catch (e) {
              console.warn(`[Outbox] delivery failed for ${event.eventId}:`, e);
              this.imService.markOutboxRetry(event.eventId);
            }
          })
        );
        this.tickCount++;
      }

      // 定期清理已投递的旧事件（防止 outbox 表无限膨胀）
      if (this.tickCount >= OutboxWorker.CLEANUP_EVERY_TICKS) {
        this.tickCount = 0;
        this.cleanupOldEvents();
      }
    } catch (e) {
      console.error("[Outbox] tick error:", e);
    } finally {
      this.processing = false;
    }
  }

  /** 清理 7 天前已投递的事件 */
  private cleanupOldEvents(): void {
    try {
      const cutoff = Date.now() - OutboxWorker.CLEANUP_OLDER_THAN_MS;
      const deleted = this.imService.cleanupDeliveredEvents(cutoff);
      if (deleted > 0) {
        console.log(`[Outbox] Cleaned up ${deleted} delivered events older than 7 days`);
      }
    } catch (e) {
      console.warn("[Outbox] cleanup failed:", e);
    }
  }
}
