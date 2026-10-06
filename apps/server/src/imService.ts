/**
 * IM 消息服务层
 *
 * 核心职责：
 * 1. 会话管理（DM/群组 CRUD + 成员管理）
 * 2. 消息收发（seq 原子递增 + 幂等去重 + 全文搜索索引）
 * 3. 已读/未读（水位线 + 计数）
 * 4. 消息编辑/撤回（软删除 + 编辑标记）
 * 5. 表情回应 / 置顶 / 静音
 * 6. 事件 Outbox（可靠投递队列）
 * 7. Handoff 跨 Agent 接力
 *
 * 设计参考：
 * - TabTin: Outbox 模式、seq 原子递增、统一权限入口、稀疏状态
 * - Wake: FTS5 全文搜索、Handoff 管道、UCS 数据结构
 *
 * 所有写操作走 node:sqlite 的事务保证原子性。
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ImConversation,
  ImMessage,
  ImMember,
  ImConversationState,
  ImReaction,
  ImEventOutbox,
  ImHandoff,
  SendMessageRequest,
  CreateDmRequest,
  CreateGroupRequest,
  CursorPage,
  UnreadCount,
  SearchResult,
  MessageMetadata,
  MemberRole,
  MemberType,
} from "@termany/core";

/** 消息撤回时间窗口（毫秒），默认 5 分钟 */
const RECALL_WINDOW_MS = 5 * 60 * 1000;

// ─── Schema 迁移 ──────────────────────────────────────

/**
 * 初始化 IM 系统所需的全部表 + 索引 + 触发器。
 * 幂等：所有语句用 IF NOT EXISTS。
 */
export function migrateImSchema(db: DatabaseSync): void {
  db.exec(`
    -- 会话表
    CREATE TABLE IF NOT EXISTS im_conversation (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'dm',
      title TEXT NOT NULL DEFAULT '',
      dm_hash TEXT UNIQUE,
      latest_seq INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_im_conv_updated ON im_conversation(updated_at DESC);

    -- 消息表
    CREATE TABLE IF NOT EXISTS im_message (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      sender_type TEXT NOT NULL DEFAULT 'user',
      sender_id TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      message_type TEXT NOT NULL DEFAULT 'text',
      metadata TEXT NOT NULL DEFAULT '{}',
      reply_to_seq INTEGER,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      edited_at INTEGER,
      client_request_id TEXT UNIQUE,
      search_text TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      sidechain_id TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      reply_group_id TEXT,
      FOREIGN KEY (conversation_id) REFERENCES im_conversation(id)
    );
    CREATE INDEX IF NOT EXISTS idx_im_msg_conv_seq ON im_message(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_im_msg_conv_id ON im_message(conversation_id, id DESC);

    -- 会话成员表
    CREATE TABLE IF NOT EXISTS im_conversation_member (
      conversation_id TEXT NOT NULL,
      user_or_bot_id TEXT NOT NULL,
      member_type TEXT NOT NULL DEFAULT 'user',
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, user_or_bot_id)
    );

    -- 用户会话状态（已读水位/静音/置顶）
    CREATE TABLE IF NOT EXISTS im_conversation_state (
      conversation_id TEXT NOT NULL,
      user_or_bot_id TEXT NOT NULL,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      history_cleared_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, user_or_bot_id)
    );

    -- 表情回应
    CREATE TABLE IF NOT EXISTS im_reaction (
      message_id INTEGER NOT NULL,
      user_or_bot_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (message_id, user_or_bot_id, emoji),
      FOREIGN KEY (message_id) REFERENCES im_message(id)
    );

    -- 事件 Outbox（可靠投递队列）
    CREATE TABLE IF NOT EXISTS im_event_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON im_event_outbox(status, created_at);

    -- Handoff 跨 Agent 接力记录
    CREATE TABLE IF NOT EXISTS im_handoff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL UNIQUE,
      source_conversation_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      distill_mode TEXT NOT NULL DEFAULT 'rules',
      snapshot_json TEXT NOT NULL,
      rendered_content TEXT NOT NULL,
      handoff_note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_handoff_conv ON im_handoff(source_conversation_id);
    CREATE INDEX IF NOT EXISTS idx_handoff_created ON im_handoff(created_at DESC);
  `);

  // 增量迁移：给已存在的 im_message 表加 sidechain_id + is_pinned 列
  try {
    db.exec("ALTER TABLE im_message ADD COLUMN sidechain_id TEXT");
  } catch { /* column already exists */ }
  try {
    db.exec("ALTER TABLE im_message ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  try {
    db.exec("ALTER TABLE im_message ADD COLUMN reply_group_id TEXT");
  } catch { /* column already exists */ }

  // 侧链索引（依赖 sidechain_id 列，必须在 ALTER TABLE 之后）
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_im_msg_sidechain ON im_message(conversation_id, sidechain_id)
      WHERE sidechain_id IS NOT NULL
    `);
  } catch { /* column may not exist yet on very old schemas */ }

  // 迁移旧数据：把 metadata 中的 isPinned 迁移到独立列
  try {
    db.exec(`
      UPDATE im_message SET is_pinned = 1
      WHERE is_pinned = 0 AND json_extract(metadata, '$.isPinned') = 1
    `);
  } catch { /* migration best-effort */ }

  // FTS5 全文搜索（单独执行，某些 Node 版本 FTS5 需要确认支持）
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS im_message_fts USING fts5(
        conversation_id, content, search_text,
        content='im_message', content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS im_msg_fts_insert AFTER INSERT ON im_message BEGIN
        INSERT INTO im_message_fts(rowid, conversation_id, content, search_text)
        VALUES (new.id, new.conversation_id, new.content, new.search_text);
      END;

      CREATE TRIGGER IF NOT EXISTS im_msg_fts_delete AFTER DELETE ON im_message BEGIN
        INSERT INTO im_message_fts(im_message_fts, rowid, conversation_id, content, search_text)
        VALUES ('delete', old.id, old.conversation_id, old.content, old.search_text);
      END;

      CREATE TRIGGER IF NOT EXISTS im_msg_fts_update AFTER UPDATE OF content, search_text ON im_message BEGIN
        INSERT INTO im_message_fts(im_message_fts, rowid, conversation_id, content, search_text)
        VALUES ('delete', old.id, old.conversation_id, old.content, old.search_text);
        INSERT INTO im_message_fts(rowid, conversation_id, content, search_text)
        VALUES (new.id, new.conversation_id, new.content, new.search_text);
      END;
    `);
  } catch {
    // FTS5 不可用时降级：搜索走 LIKE 子串匹配
    console.warn("[IM] FTS5 unavailable, search will fallback to LIKE");
  }
}

// ─── 工具函数 ─────────────────────────────────────────

function genId(): string {
  return randomUUID();
}

function dmHash(a: string, b: string): string {
  const sorted = [a, b].sort();
  return createHash("sha256").update(sorted.join(":")).digest("hex");
}

function now(): number {
  return Date.now();
}

/** 构建搜索聚合文本 = content + 文件名 + 卡片标题 */
function buildSearchText(content: string, metadata: Partial<MessageMetadata> | undefined): string {
  const parts = [content];
  if (metadata?.file?.name) parts.push(metadata.file.name);
  if (metadata?.card?.title) parts.push(metadata.card.title);
  if (metadata?.card?.description) parts.push(metadata.card.description);
  return parts.filter(Boolean).join(" ").slice(0, 2000);
}

/** 构建会话预览文本 */
function buildPreview(content: string, messageType: string, metadata?: Partial<MessageMetadata>): string {
  if (messageType === "file") return `[文件] ${metadata?.file?.name ?? "未知文件"}`;
  if (messageType === "image") return "[图片]";
  if (metadata?.card?.title) return `[卡片] ${metadata.card.title}`;
  return content.slice(0, 200);
}

// ─── 会话管理 ─────────────────────────────────────────

export class ImService {
  constructor(private db: DatabaseSync) {}

  /** 创建或复用 DM 会话（幂等） */
  createDm(req: CreateDmRequest): ImConversation {
    const hash = dmHash(req.userId, req.targetId);

    // 先查已有
    const existing = this.db.prepare(
      "SELECT * FROM im_conversation WHERE dm_hash = ?"
    ).get(hash) as RawConversation | undefined;

    if (existing) {
      return this.hydrateConversation(existing);
    }

    const id = genId();
    const ts = now();

    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `INSERT INTO im_conversation (id, type, title, dm_hash, latest_seq, created_at, updated_at)
         VALUES (?, 'dm', '', ?, 0, ?, ?)`
      ).run(id, hash, ts, ts);

      // 添加两个成员
      this.db.prepare(
        `INSERT INTO im_conversation_member (conversation_id, user_or_bot_id, member_type, role, joined_at)
         VALUES (?, ?, 'user', 'owner', ?)`
      ).run(id, req.userId, ts);

      this.db.prepare(
        `INSERT INTO im_conversation_member (conversation_id, user_or_bot_id, member_type, role, joined_at)
         VALUES (?, ?, ?, 'owner', ?)`
      ).run(id, req.targetId, req.targetType, ts);

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return {
      id,
      type: "dm",
      title: "",
      dmHash: hash,
      latestSeq: 0,
      createdAt: ts,
      updatedAt: ts,
      preview: "",
      memberCount: 2,
    };
  }

  /** 创建群组会话 */
  createGroup(req: CreateGroupRequest): ImConversation {
    const id = genId();
    const ts = now();

    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `INSERT INTO im_conversation (id, type, title, latest_seq, created_at, updated_at)
         VALUES (?, 'group', ?, 0, ?, ?)`
      ).run(id, req.title, ts, ts);

      for (const m of req.members) {
        this.db.prepare(
          `INSERT INTO im_conversation_member (conversation_id, user_or_bot_id, member_type, role, joined_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(id, m.id, m.type, m.role ?? "member", ts);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return {
      id,
      type: "group",
      title: req.title,
      dmHash: null,
      latestSeq: 0,
      createdAt: ts,
      updatedAt: ts,
      preview: "",
      memberCount: req.members.length,
    };
  }

  /** 获取会话列表（按 updatedAt 降序，置顶优先） */
  listConversations(userId: string, limit = 50): ImConversation[] {
    const rows = this.db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM im_conversation_member WHERE conversation_id = c.id) as member_count
      FROM im_conversation c
      WHERE c.id IN (
        SELECT conversation_id FROM im_conversation_member WHERE user_or_bot_id = ?
      )
      ORDER BY
        COALESCE((SELECT pinned FROM im_conversation_state
                  WHERE conversation_id = c.id AND user_or_bot_id = ?), 0) DESC,
        c.updated_at DESC
      LIMIT ?
    `).all(userId, userId, limit) as (RawConversation & { member_count: number })[];

    return rows.map((r) => this.hydrateConversation(r, r.member_count));
  }

  /** 获取单个会话 */
  getConversation(conversationId: string): ImConversation | null {
    const row = this.db.prepare(
      "SELECT * FROM im_conversation WHERE id = ?"
    ).get(conversationId) as RawConversation | undefined;
    if (!row) return null;

    const memberCount = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM im_conversation_member WHERE conversation_id = ?"
    ).get(conversationId) as { cnt: number }).cnt;

    return this.hydrateConversation(row, memberCount);
  }

  /** 更新会话标题 */
  updateConversation(conversationId: string, title: string): void {
    this.db.prepare(
      "UPDATE im_conversation SET title = ?, updated_at = ? WHERE id = ?"
    ).run(title, now(), conversationId);
  }

  // ─── 成员管理 ───────────────────────────────────────

  addMember(conversationId: string, userId: string, type: MemberType, role: MemberRole = "member"): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO im_conversation_member (conversation_id, user_or_bot_id, member_type, role, joined_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(conversationId, userId, type, role, now());
  }

  removeMember(conversationId: string, userId: string): void {
    this.db.prepare(
      "DELETE FROM im_conversation_member WHERE conversation_id = ? AND user_or_bot_id = ?"
    ).run(conversationId, userId);
  }

  listMembers(conversationId: string): ImMember[] {
    return this.db.prepare(
      "SELECT * FROM im_conversation_member WHERE conversation_id = ?"
    ).all(conversationId) as ImMember[];
  }

  isMember(conversationId: string, userId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM im_conversation_member WHERE conversation_id = ? AND user_or_bot_id = ?"
    ).get(conversationId, userId) as { 1: number } | undefined;
    return !!row;
  }

  // ─── 消息收发 ───────────────────────────────────────

  /**
   * 发送消息
   *
   * 核心流程（参考 TabTin message_service.py）：
   * 1. 幂等去重（client_request_id）
   * 2. 事务内：锁会话行 → 分配 seq → 写消息 → 更新会话预览 → 写 outbox
   * 3. 事务外：构建搜索索引
   */
  sendMessage(conversationId: string, req: SendMessageRequest): ImMessage {
    // 权限校验：发送者必须是会话成员
    if (!this.isMember(conversationId, req.senderId)) {
      throw new Error(`sender ${req.senderId} is not a member of conversation ${conversationId}`);
    }

    const ts = now();
    const metadata = req.metadata ?? {};
    const messageType = req.messageType ?? "text";
    const searchText = buildSearchText(req.content, metadata);
    const clientRequestId = req.clientRequestId ?? null;

    // 幂等检查
    if (clientRequestId) {
      const existing = this.db.prepare(
        "SELECT * FROM im_message WHERE client_request_id = ?"
      ).get(clientRequestId) as RawMessage | undefined;
      if (existing) {
        return this.hydrateMessage(existing);
      }
    }

    this.db.exec("BEGIN");
    let seq: number;
    try {
      // 原子分配 seq（参考 TabTin 的 UPDATE ... RETURNING 模式）
      // node:sqlite 不支持 RETURNING，所以用 SELECT + UPDATE 在事务内实现
      const conv = this.db.prepare(
        "SELECT latest_seq FROM im_conversation WHERE id = ?"
      ).get(conversationId) as { latest_seq: number } | undefined;

      if (!conv) {
        this.db.exec("ROLLBACK");
        throw new Error(`conversation ${conversationId} not found`);
      }

      seq = conv.latest_seq + 1;

      // 更新会话的 latest_seq + preview + updated_at
      const preview = buildPreview(req.content, messageType, metadata);
      this.db.prepare(
        `UPDATE im_conversation
         SET latest_seq = ?, preview = ?, updated_at = ?
         WHERE id = ?`
      ).run(seq, preview, ts, conversationId);

      // 写入消息
      const result = this.db.prepare(
        `INSERT INTO im_message
         (conversation_id, seq, role, sender_type, sender_id, content, message_type, metadata, reply_to_seq, client_request_id, search_text, created_at, sidechain_id, reply_group_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        conversationId, seq, req.role, req.senderType, req.senderId,
        req.content, messageType, JSON.stringify(metadata),
        req.replyToSeq ?? null, clientRequestId, searchText, ts,
        req.sidechainId ?? null, req.replyGroupId ?? null
      );

      // 写入 Outbox（可靠投递）
      const eventId = randomUUID();
      this.db.prepare(
        `INSERT INTO im_event_outbox (event_id, channel, event_type, payload, status, created_at, updated_at)
         VALUES (?, ?, 'im.message', ?, 'pending', ?, ?)`
      ).run(
        eventId,
        `conversation:${conversationId}`,
        JSON.stringify({ conversationId, seq, senderId: req.senderId }),
        ts, ts
      );

      this.db.exec("COMMIT");

      return {
        id: Number(result.lastInsertRowid),
        conversationId,
        seq,
        role: req.role,
        senderType: req.senderType,
        senderId: req.senderId,
        content: req.content,
        messageType: messageType as any,
        metadata: metadata as MessageMetadata,
        replyToSeq: req.replyToSeq ?? null,
        isDeleted: false,
        editedAt: null,
        clientRequestId,
        searchText,
        createdAt: ts,
        sidechainId: req.sidechainId ?? null,
        isPinned: false,
        replyGroupId: req.replyGroupId ?? null,
      };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 获取消息历史（cursor 分页，按 seq 降序） */
  getMessages(
    conversationId: string,
    options: { beforeSeq?: number; limit?: number; userId?: string } = {}
  ): CursorPage<ImMessage> {
    const limit = Math.min(options.limit ?? 40, 100);
    const beforeSeq = options.beforeSeq ?? Number.MAX_SAFE_INTEGER;

    const rows = this.db.prepare(`
      SELECT * FROM im_message
      WHERE conversation_id = ? AND seq < ? AND is_deleted = 0
      ORDER BY seq DESC
      LIMIT ?
    `).all(conversationId, beforeSeq, limit + 1) as RawMessage[];

    const hasMore = rows.length > limit;
    // 保持 seq 降序（最新在前），用于 cursor 分页
    const descItems = rows.slice(0, limit).map((r) => this.hydrateMessage(r));

    // cursor = 本页最后一条（最旧的）的 seq，下次请求 before_seq=cursor 取更旧的
    const nextCursor = hasMore && descItems.length > 0 ? descItems[descItems.length - 1].seq : null;

    // 反转为 seq 升序（时间正序）返回给调用方
    const items = [...descItems].reverse();

    // 聚合表情回应
    if (items.length > 0) {
      const msgIds = items.map((m) => m.id);
      const placeholders = msgIds.map(() => "?").join(",");
      const rawReactions = this.db.prepare(
        `SELECT * FROM im_reaction WHERE message_id IN (${placeholders})`
      ).all(...msgIds) as Array<Record<string, unknown>>;

      // snake_case → camelCase 映射
      const reactions: ImReaction[] = rawReactions.map((r) => ({
        messageId: Number(r.message_id),
        userOrBotId: String(r.user_or_bot_id),
        emoji: String(r.emoji),
        createdAt: Number(r.created_at),
      }));

      const reactionMap = new Map<number, ImReaction[]>();
      for (const r of reactions) {
        if (!reactionMap.has(r.messageId)) reactionMap.set(r.messageId, []);
        reactionMap.get(r.messageId)!.push(r);
      }

      for (const msg of items) {
        msg.reactions = reactionMap.get(msg.id) ?? [];
      }
    }

    return { items, nextCursor, hasMore };
  }

  /** 获取单条消息 */
  getMessage(messageId: number): ImMessage | null {
    const row = this.db.prepare(
      "SELECT * FROM im_message WHERE id = ?"
    ).get(messageId) as RawMessage | undefined;
    return row ? this.hydrateMessage(row) : null;
  }

  /** 按 seq 获取消息 */
  getMessageBySeq(conversationId: string, seq: number): ImMessage | null {
    const row = this.db.prepare(
      "SELECT * FROM im_message WHERE conversation_id = ? AND seq = ?"
    ).get(conversationId, seq) as RawMessage | undefined;
    return row ? this.hydrateMessage(row) : null;
  }

  // ─── 消息编辑 / 撤回 ───────────────────────────────

  /** 编辑消息（仅发送者可编辑、仅文本） */
  editMessage(messageId: number, senderId: string, content: string): ImMessage {
    const msg = this.getMessage(messageId);
    if (!msg) throw new Error("message not found");
    if (msg.senderId !== senderId) throw new Error("only sender can edit");
    if (msg.messageType !== "text") throw new Error("only text messages can be edited");
    if (msg.isDeleted) throw new Error("message is deleted");

    const ts = now();
    const searchText = buildSearchText(content, msg.metadata);

    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `UPDATE im_message SET content = ?, search_text = ?, edited_at = ? WHERE id = ?`
      ).run(content, searchText, ts, messageId);

      // outbox 事件写入事务内，保证一致性
      this.enqueueOutboxEvent(
        `conversation:${msg.conversationId}`,
        "im.message.edited",
        { conversationId: msg.conversationId, seq: msg.seq, messageId }
      );

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return { ...msg, content, searchText, editedAt: ts };
  }

  /** 撤回消息（仅发送者、RECALL_WINDOW_MS 内） */
  deleteMessage(messageId: number, senderId: string): void {
    const msg = this.getMessage(messageId);
    if (!msg) throw new Error("message not found");
    if (msg.senderId !== senderId) throw new Error("only sender can delete");
    if (msg.isDeleted) return; // 幂等

    // 可配置的撤回窗口
    if (now() - msg.createdAt > RECALL_WINDOW_MS) {
      throw new Error(`recall window expired (${RECALL_WINDOW_MS / 60000} minutes)`);
    }

    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        "UPDATE im_message SET is_deleted = 1 WHERE id = ?"
      ).run(messageId);

      // 更新会话预览（如果被撤回的是最新消息）
      const conv = this.getConversation(msg.conversationId);
      if (conv && conv.latestSeq === msg.seq) {
        this.db.prepare(
          "UPDATE im_conversation SET preview = '消息已撤回', updated_at = ? WHERE id = ?"
        ).run(now(), msg.conversationId);
      }

      // outbox 事件写入事务内
      this.enqueueOutboxEvent(
        `conversation:${msg.conversationId}`,
        "im.message.deleted",
        { conversationId: msg.conversationId, seq: msg.seq, messageId }
      );

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ─── 已读/未读 ──────────────────────────────────────

  /** 标记已读（推进水位） */
  markAsRead(conversationId: string, userId: string, seq: number): void {
    this.db.prepare(
      `INSERT INTO im_conversation_state (conversation_id, user_or_bot_id, last_read_seq, muted, pinned, history_cleared_seq)
       VALUES (?, ?, ?, 0, 0, 0)
       ON CONFLICT(conversation_id, user_or_bot_id)
       DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`
    ).run(conversationId, userId, seq);
  }

  /** 获取各会话未读计数 */
  getUnreadCounts(userId: string): UnreadCount[] {
    const rows = this.db.prepare(`
      SELECT
        c.id as conversation_id,
        c.latest_seq,
        COALESCE(s.last_read_seq, 0) as last_read_seq,
        COALESCE(s.history_cleared_seq, 0) as history_cleared_seq
      FROM im_conversation c
      LEFT JOIN im_conversation_state s ON s.conversation_id = c.id AND s.user_or_bot_id = ?
      WHERE c.id IN (
        SELECT conversation_id FROM im_conversation_member WHERE user_or_bot_id = ?
      )
    `).all(userId, userId) as {
      conversation_id: string;
      latest_seq: number;
      last_read_seq: number;
      history_cleared_seq: number;
    }[];

    return rows.map((r) => {
      const waterMark = Math.max(r.last_read_seq, r.history_cleared_seq);
      const unread = Math.max(0, r.latest_seq - waterMark);
      return {
        conversationId: r.conversation_id,
        unread,
        mentionUnread: 0, // TODO: 从 mention 表统计
      };
    });
  }

  /** 获取单个会话的未读计数 */
  getUnreadCount(conversationId: string, userId: string): number {
    const conv = this.getConversation(conversationId);
    if (!conv) return 0;

    const state = this.getConversationState(conversationId, userId);
    const waterMark = Math.max(state.lastReadSeq, state.historyClearedSeq);
    return Math.max(0, conv.latestSeq - waterMark);
  }

  /** 获取用户会话状态 */
  getConversationState(conversationId: string, userId: string): ImConversationState {
    const row = this.db.prepare(
      "SELECT * FROM im_conversation_state WHERE conversation_id = ? AND user_or_bot_id = ?"
    ).get(conversationId, userId) as Record<string, unknown> | undefined;

    if (!row) {
      return {
        conversationId,
        userOrBotId: userId,
        lastReadSeq: 0,
        muted: false,
        pinned: false,
        historyClearedSeq: 0,
      };
    }

    return {
      conversationId: String(row.conversation_id),
      userOrBotId: String(row.user_or_bot_id),
      lastReadSeq: Number(row.last_read_seq ?? 0),
      muted: Number(row.muted ?? 0) === 1,
      pinned: Number(row.pinned ?? 0) === 1,
      historyClearedSeq: Number(row.history_cleared_seq ?? 0),
    };
  }

  // ─── 置顶 / 静音 ───────────────────────────────────

  pinConversation(conversationId: string, userId: string, pinned: boolean): void {
    this.db.prepare(
      `INSERT INTO im_conversation_state (conversation_id, user_or_bot_id, last_read_seq, muted, pinned, history_cleared_seq)
       VALUES (?, ?, 0, 0, ?, 0)
       ON CONFLICT(conversation_id, user_or_bot_id) DO UPDATE SET pinned = excluded.pinned`
    ).run(conversationId, userId, pinned ? 1 : 0);
  }

  muteConversation(conversationId: string, userId: string, muted: boolean): void {
    this.db.prepare(
      `INSERT INTO im_conversation_state (conversation_id, user_or_bot_id, last_read_seq, muted, pinned, history_cleared_seq)
       VALUES (?, ?, 0, ?, 0, 0)
       ON CONFLICT(conversation_id, user_or_bot_id) DO UPDATE SET muted = excluded.muted`
    ).run(conversationId, userId, muted ? 1 : 0);
  }

  // ─── 消息置顶 ───────────────────────────────────────

  pinMessage(messageId: number, pinned: boolean): void {
    const msg = this.getMessage(messageId);
    if (!msg) throw new Error("message not found");

    this.db.prepare(
      "UPDATE im_message SET is_pinned = ? WHERE id = ?"
    ).run(pinned ? 1 : 0, messageId);
  }

  getPinnedMessages(conversationId: string): ImMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM im_message
      WHERE conversation_id = ? AND is_deleted = 0 AND is_pinned = 1
      ORDER BY seq DESC
    `).all(conversationId) as RawMessage[];
    return rows.map((r) => this.hydrateMessage(r));
  }

  // ─── 侧链 ───────────────────────────────────────────

  /** 创建侧链（返回 sidechain_id） */
  createSidechain(conversationId: string): string {
    const sidechainId = `sc_${randomUUID().slice(0, 12)}`;
    // 侧链 ID 存于 im_message.sidechain_id，无需独立表
    return sidechainId;
  }

  /** 获取侧链消息 */
  getSidechainMessages(conversationId: string, sidechainId: string): ImMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM im_message
      WHERE conversation_id = ? AND sidechain_id = ? AND is_deleted = 0
      ORDER BY seq ASC
    `).all(conversationId, sidechainId) as RawMessage[];
    return rows.map((r) => this.hydrateMessage(r));
  }

  /** 获取会话的侧链 ID 列表（按首次出现顺序排序） */
  listSidechains(conversationId: string): string[] {
    const rows = this.db.prepare(`
      SELECT sidechain_id, MIN(seq) as first_seq FROM im_message
      WHERE conversation_id = ? AND sidechain_id IS NOT NULL AND is_deleted = 0
      GROUP BY sidechain_id
      ORDER BY first_seq
    `).all(conversationId) as { sidechain_id: string }[];
    return rows.map((r) => r.sidechain_id);
  }

  // ─── 表情回应 ───────────────────────────────────────

  addReaction(messageId: number, userId: string, emoji: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO im_reaction (message_id, user_or_bot_id, emoji, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(messageId, userId, emoji, now());
  }

  removeReaction(messageId: number, userId: string, emoji: string): void {
    this.db.prepare(
      "DELETE FROM im_reaction WHERE message_id = ? AND user_or_bot_id = ? AND emoji = ?"
    ).run(messageId, userId, emoji);
  }

  // ─── 全文搜索 ───────────────────────────────────────

  /** 将 snake_case DB 行映射为 camelCase SearchResult */
  private hydrateSearchResult(r: Record<string, unknown>): SearchResult {
    return {
      messageId: Number(r.message_id),
      conversationId: String(r.conversation_id),
      seq: Number(r.seq),
      content: String(r.content),
      snippet: String(r.snippet ?? r.content),
      rank: Number(r.rank ?? 0),
      createdAt: Number(r.created_at),
      senderId: String(r.sender_id),
    };
  }

  search(query: string, options: { conversationId?: string; limit?: number } = {}): SearchResult[] {
    const limit = Math.min(options.limit ?? 20, 50);

    // 优先 FTS5（有排名、有索引、支持 snippet 高亮）
    try {
      const ftsQuery = query.split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
      const ftsConvFilter = options.conversationId ? "AND f.conversation_id = ?" : "";
      const ftsParams = options.conversationId
        ? [ftsQuery, options.conversationId, limit]
        : [ftsQuery, limit];

      const ftsRaw = this.db.prepare(`
        SELECT
          m.id as message_id, m.conversation_id, m.seq, m.content,
          snippet(im_message_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
          rank, m.created_at, m.sender_id
        FROM im_message_fts f
        JOIN im_message m ON m.id = f.rowid
        WHERE im_message_fts MATCH ? ${ftsConvFilter}
        ORDER BY rank
        LIMIT ?
      `).all(...ftsParams) as Array<Record<string, unknown>>;

      if (ftsRaw.length > 0) {
        return ftsRaw.map((r) => this.hydrateSearchResult(r));
      }
    } catch {
      // FTS5 不可用（扩展未加载 / 虚拟表不存在），降级到 LIKE
    }

    // FTS5 无结果或不可用 → LIKE 子串匹配兜底（CJK 兼容）
    const likeQuery = `%${query}%`;
    const convFilter = options.conversationId ? "AND conversation_id = ?" : "";
    const params = options.conversationId
      ? [likeQuery, likeQuery, options.conversationId, limit]
      : [likeQuery, likeQuery, limit];

    const rawResults = this.db.prepare(`
      SELECT
        id as message_id,
        conversation_id,
        seq,
        content,
        content as snippet,
        0 as rank,
        created_at,
        sender_id
      FROM im_message
      WHERE is_deleted = 0
        AND (content LIKE ? OR search_text LIKE ?)
        ${convFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;

    return rawResults.map((r) => this.hydrateSearchResult(r));
  }

  // ─── Outbox ─────────────────────────────────────────

  private enqueueOutboxEvent(channel: string, eventType: string, payload: unknown): void {
    const ts = now();
    this.db.prepare(
      `INSERT INTO im_event_outbox (event_id, channel, event_type, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    ).run(randomUUID(), channel, eventType, JSON.stringify(payload), ts, ts);
  }

  /** 获取待投递事件（claim 模式） */
  claimOutboxEvents(batchSize = 10): ImEventOutbox[] {
    const ts = now();
    const token = randomUUID();
    const leaseMs = 30_000; // 30s

    this.db.exec("BEGIN");
    try {
      const rows = this.db.prepare(`
        SELECT * FROM im_event_outbox
        WHERE status IN ('pending', 'retry')
          AND (lease_expires_at IS NULL OR lease_expires_at < ?)
        ORDER BY created_at
        LIMIT ?
      `).all(ts, batchSize) as RawOutbox[];

      if (rows.length === 0) {
        this.db.exec("COMMIT");
        return [];
      }

      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const newLease = ts + leaseMs;

      this.db.prepare(
        `UPDATE im_event_outbox
         SET status = 'pending', claim_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id IN (${placeholders})`
      ).run(token, newLease, ts, ...ids);

      this.db.exec("COMMIT");
      return rows.map((r) => this.hydrateOutbox(r));
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 标记事件已投递 */
  markOutboxDelivered(eventId: string): void {
    this.db.prepare(
      "UPDATE im_event_outbox SET status = 'delivered', updated_at = ? WHERE event_id = ?"
    ).run(now(), eventId);
  }

  /** 标记事件投递失败（指数退避） */
  markOutboxRetry(eventId: string): void {
    const row = this.db.prepare(
      "SELECT attempts FROM im_event_outbox WHERE event_id = ?"
    ).get(eventId) as { attempts: number } | undefined;

    if (!row) return;

    const attempts = row.attempts + 1;
    const status = attempts >= 8 ? "dead" : "retry";
    // 指数退避：2^attempts 秒，上限 300s
    const backoffMs = Math.min(300, Math.pow(2, attempts)) * 1000;
    const leaseExpires = now() + backoffMs;

    this.db.prepare(
      `UPDATE im_event_outbox
       SET status = ?, attempts = ?, lease_expires_at = ?, updated_at = ?
       WHERE event_id = ?`
    ).run(status, attempts, leaseExpires, now(), eventId);
  }

  /** 清理已投递的旧事件（防止 outbox 表膨胀） */
  cleanupDeliveredEvents(olderThan: number): number {
    const result = this.db.prepare(
      `DELETE FROM im_event_outbox
       WHERE status = 'delivered' AND updated_at < ?`
    ).run(olderThan);
    return result.changes;
  }

  // ─── Hydration（数据库行 → 领域对象） ────────────────

  private hydrateConversation(row: RawConversation, memberCount?: number): ImConversation {
    return {
      id: row.id,
      type: row.type as "dm" | "group",
      title: row.title,
      dmHash: row.dm_hash,
      latestSeq: row.latest_seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      preview: row.preview ?? "",
      memberCount: memberCount ?? 0,
    };
  }

  private hydrateMessage(row: RawMessage): ImMessage {
    let metadata: MessageMetadata = {};
    try {
      metadata = JSON.parse(row.metadata || "{}");
    } catch { /* ignore */ }

    return {
      id: row.id,
      conversationId: row.conversation_id,
      seq: row.seq,
      role: row.role as any,
      senderType: row.sender_type as any,
      senderId: row.sender_id,
      content: row.content,
      messageType: row.message_type as any,
      metadata,
      replyToSeq: row.reply_to_seq,
      isDeleted: row.is_deleted === 1,
      editedAt: row.edited_at,
      clientRequestId: row.client_request_id,
      searchText: row.search_text,
      createdAt: row.created_at,
      sidechainId: row.sidechain_id,
      isPinned: row.is_pinned === 1,
      replyGroupId: row.reply_group_id,
    };
  }

  private hydrateOutbox(row: RawOutbox): ImEventOutbox {
    return {
      id: row.id,
      eventId: row.event_id,
      channel: row.channel,
      eventType: row.event_type,
      payload: row.payload,
      status: row.status as any,
      attempts: row.attempts,
      claimToken: row.claim_token,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ─── 内部类型（数据库行格式） ─────────────────────────

interface RawConversation {
  id: string;
  type: string;
  title: string;
  dm_hash: string | null;
  latest_seq: number;
  preview?: string;
  created_at: number;
  updated_at: number;
}

interface RawMessage {
  id: number;
  conversation_id: string;
  seq: number;
  role: string;
  sender_type: string;
  sender_id: string;
  content: string;
  message_type: string;
  metadata: string;
  reply_to_seq: number | null;
  is_deleted: number;
  edited_at: number | null;
  client_request_id: string | null;
  search_text: string;
  created_at: number;
  sidechain_id: string | null;
  is_pinned: number;
  reply_group_id: string | null;
}

interface RawOutbox {
  id: number;
  event_id: string;
  channel: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  claim_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}
