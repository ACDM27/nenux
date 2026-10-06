/**
 * IM 消息系统类型定义
 *
 * 参考 TabTin 的消息模型设计，适配 Termany 的本地 SQLite 架构。
 * 消息从 workspace JSON blob 迁移到独立关系表，引入 seq 原子递增序号。
 */

// ─── 会话 ────────────────────────────────────────────

export type ConversationType = "dm" | "group";

export interface ImConversation {
  id: string;
  type: ConversationType;
  title: string;
  dmHash: string | null;       // sha256(sorted([a,b])) — DM 去重
  latestSeq: number;           // 原子递增消息序号
  createdAt: number;
  updatedAt: number;
  /** 会话列表中的预览文本（最后一条消息摘要） */
  preview: string;
  /** 成员数（群组时有意义） */
  memberCount: number;
}

export interface CreateDmRequest {
  /** 当前用户 ID */
  userId: string;
  /** 对方用户或 bot ID */
  targetId: string;
  /** 对方类型 */
  targetType: "user" | "bot";
}

export interface CreateGroupRequest {
  /** 群组标题 */
  title: string;
  /** 创建者 ID */
  ownerId: string;
  /** 初始成员（含 owner） */
  members: Array<{
    id: string;
    type: "user" | "bot";
    role?: "owner" | "admin" | "member";
  }>;
  /** 幂等去重键 */
  clientRequestId?: string;
}

// ─── 消息 ────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";
export type SenderType = "user" | "agent" | "system";
export type MessageType = "text" | "file" | "image" | "system";

export interface ImMessage {
  id: number;
  conversationId: string;
  seq: number;
  role: MessageRole;
  senderType: SenderType;
  /** 发送者 ID（user_id 或 bot_id） */
  senderId: string;
  content: string;
  messageType: MessageType;
  metadata: MessageMetadata;
  replyToSeq: number | null;
  isDeleted: boolean;
  editedAt: number | null;
  clientRequestId: string | null;
  searchText: string;
  createdAt: number;
  /** 聚合的表情回应 */
  reactions?: ImReaction[];
  /** 发送者名字（查询时附带） */
  senderName?: string;
  /** 侧链 ID（null = 主线消息） */
  sidechainId: string | null;
  /** 是否置顶 */
  isPinned: boolean;
  /** 气泡拆分组 ID（同组气泡共享） */
  replyGroupId: string | null;
}

export interface MessageMetadata {
  /** 文件附件信息 */
  file?: { name: string; size: number; url: string; mimeType?: string };
  /** 图片信息 */
  image?: { url: string; width?: number; height?: number };
  /** @mention 列表 */
  mentions?: Array<{ id: string; type: "user" | "bot"; name: string }>;
  /** 卡片数据 */
  card?: { type: string; title: string; description?: string; data?: unknown };
  /** 气泡拆分组 ID */
  replyGroupId?: string;
  /** 侧链 ID */
  sidechainId?: string;
}

export interface SendMessageRequest {
  /** 发送者 ID */
  senderId: string;
  senderType: SenderType;
  role: MessageRole;
  content: string;
  messageType?: MessageType;
  metadata?: Partial<MessageMetadata>;
  replyToSeq?: number;
  /** 幂等去重键 */
  clientRequestId?: string;
  /** 侧链 ID（null 或省略 = 主线消息） */
  sidechainId?: string;
  /** 气泡拆分组 ID（由 bubble split 生成） */
  replyGroupId?: string;
}

export interface EditMessageRequest {
  content: string;
}

// ─── 成员 ────────────────────────────────────────────

export type MemberRole = "owner" | "admin" | "member";
export type MemberType = "user" | "bot";

export interface ImMember {
  conversationId: string;
  userOrBotId: string;
  memberType: MemberType;
  role: MemberRole;
  joinedAt: number;
}

// ─── 用户会话状态 ─────────────────────────────────────

export interface ImConversationState {
  conversationId: string;
  userOrBotId: string;
  lastReadSeq: number;
  muted: boolean;
  pinned: boolean;
  historyClearedSeq: number;
}

export interface UnreadCount {
  conversationId: string;
  unread: number;
  /** 包含 @mention 的未读数 */
  mentionUnread: number;
}

// ─── 表情回应 ─────────────────────────────────────────

export interface ImReaction {
  messageId: number;
  userOrBotId: string;
  emoji: string;
  createdAt: number;
}

// ─── 事件 Outbox ──────────────────────────────────────

export type OutboxStatus = "pending" | "delivered" | "retry" | "dead";

export interface ImEventOutbox {
  id: number;
  eventId: string;
  channel: string;          // conversation:{id} | personal:{userId}
  eventType: string;
  payload: string;          // JSON
  status: OutboxStatus;
  attempts: number;
  claimToken: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ─── Handoff ──────────────────────────────────────────

export interface ImHandoff {
  id: number;
  snapshotId: string;
  sourceConversationId: string;
  sourceAgentId: string;
  targetAgentId: string;
  projectPath: string;
  distillMode: "rules" | "llm";
  snapshotJson: string;
  renderedContent: string;
  handoffNote: string;
  status: "pending" | "delivered" | "failed";
  createdAt: number;
}

// ─── IM 事件类型 ──────────────────────────────────────

export enum ImEventType {
  MESSAGE = "im.message",
  MESSAGE_DELETED = "im.message.deleted",
  MESSAGE_EDITED = "im.message.edited",
  MESSAGE_PINNED = "im.message.pinned",
  MEMBER_JOINED = "im.member.joined",
  MEMBER_LEFT = "im.member.left",
  UNREAD_UPDATE = "im.unread.update",
  READ_RECEIPT = "im.read.receipt",
  REACTION_ADDED = "im.reaction.added",
  REACTION_REMOVED = "im.reaction.removed",
  TYPING = "im.typing",
  HANDOFF_UPDATE = "im.handoff.update",
  CONVERSATION_UPDATED = "im.conversation.updated",
  CONVERSATION_NEW = "im.conversation.new",
}

// ─── 搜索 ─────────────────────────────────────────────

export interface SearchResult {
  messageId: number;
  conversationId: string;
  seq: number;
  content: string;
  /** FTS 高亮片段 */
  snippet: string;
  /** 相关度排名分数 */
  rank: number;
  createdAt: number;
  senderId: string;
  senderName?: string;
}

export interface SearchRequest {
  query: string;
  conversationId?: string;
  limit?: number;
  beforeRank?: number;
}

// ─── Cursor 分页 ──────────────────────────────────────

export interface CursorPage<T> {
  items: T[];
  nextCursor: number | null;   // 下一条的 id，null 表示没有更多
  hasMore: boolean;
}

// ─── API 响应 ─────────────────────────────────────────

export interface ImApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
