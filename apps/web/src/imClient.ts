/**
 * Termany IM API 客户端
 *
 * 封装后端 IM REST API，供前端组件调用。
 * 所有方法返回 Promise，错误统一抛 Error。
 */

import { apiPath } from "./api";

// ─── 类型定义（与后端 imTypes.ts 对齐） ──────────────────

export interface ImConversation {
  id: string;
  type: "dm" | "group";
  title: string;
  dmHash: string | null;
  latestSeq: number;
  createdAt: number;
  updatedAt: number;
  preview: string;
  memberCount: number;
}

export interface ImMessage {
  id: number;
  conversationId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  senderType: "user" | "agent" | "system";
  senderId: string;
  content: string;
  messageType: "text" | "file" | "image" | "system";
  metadata: Record<string, unknown>;
  replyToSeq: number | null;
  isDeleted: boolean;
  editedAt: number | null;
  createdAt: number;
  sidechainId: string | null;
  isPinned: boolean;
  replyGroupId: string | null;
  reactions?: ImReaction[];
}

export interface ImReaction {
  messageId: number;
  userOrBotId: string;
  emoji: string;
  createdAt: number;
}

export interface UnreadCount {
  conversationId: string;
  unread: number;
  mentionUnread: number;
}

export interface SearchResult {
  messageId: number;
  conversationId: string;
  seq: number;
  content: string;
  snippet: string;
  rank: number;
  createdAt: number;
  senderId: string;
}

interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ─── HTTP 工具 ──────────────────────────────────────────

/** 所有 IM API 路径自动加 /api 前缀 */
function imPath(path: string): string {
  return apiPath(path.startsWith("/api") ? path : `/api${path}`);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(imPath(path), {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const json: ApiResponse<T> = await res.json();
  if (!json.ok) throw new Error(json.error || `IM API error: ${res.status}`);
  return json.data as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

// ─── 会话 API ───────────────────────────────────────────

export const imApi = {
  // 会话列表
  listConversations(userId = "default-user"): Promise<ImConversation[]> {
    return get(`/im/conversations?user_id=${encodeURIComponent(userId)}`);
  },

  // 创建 DM
  createDm(userId: string, targetId: string, targetType: "user" | "bot" = "user") {
    return post<ImConversation>("/im/conversations/dm", { userId, targetId, targetType });
  },

  // 创建群组
  createGroup(title: string, ownerId: string, members: Array<{ id: string; type: "user" | "bot"; role?: string }>) {
    return post<ImConversation>("/im/conversations/group", { title, ownerId, members });
  },

  // ─── 消息 API ─────────────────────────────────────────

  // 发送消息
  sendMessage(conversationId: string, opts: {
    senderId: string;
    content: string;
    senderType?: "user" | "agent";
    role?: "user" | "assistant";
    replyToSeq?: number;
    clientRequestId?: string;
    sidechainId?: string;
    replyGroupId?: string;
  }) {
    return post<ImMessage>(`/im/conversations/${conversationId}/messages`, {
      senderId: opts.senderId,
      content: opts.content,
      senderType: opts.senderType ?? "user",
      role: opts.role ?? "user",
      replyToSeq: opts.replyToSeq,
      clientRequestId: opts.clientRequestId,
      sidechainId: opts.sidechainId,
      replyGroupId: opts.replyGroupId,
    });
  },

  // 消息历史（cursor 分页）
  getMessages(conversationId: string, opts: { beforeSeq?: number; limit?: number; userId?: string } = {}) {
    const params = new URLSearchParams();
    if (opts.beforeSeq != null) params.set("before_seq", String(opts.beforeSeq));
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.userId) params.set("user_id", opts.userId);
    return get<{ items: ImMessage[]; nextCursor: number | null; hasMore: boolean }>(
      `/im/conversations/${conversationId}/messages?${params}`
    );
  },

  // 编辑消息
  editMessage(messageId: number, senderId: string, content: string) {
    return put<ImMessage>(`/im/messages/${messageId}`, { senderId, content });
  },

  // 撤回消息
  deleteMessage(messageId: number, senderId: string) {
    return del<void>(`/im/messages/${messageId}?sender_id=${encodeURIComponent(senderId)}`);
  },

  // ─── 已读/未读 ────────────────────────────────────────

  markAsRead(conversationId: string, userId: string, seq: number) {
    return post<void>(`/im/conversations/${conversationId}/read`, { userId, seq });
  },

  getUnreadCounts(userId = "default-user"): Promise<UnreadCount[]> {
    return get(`/im/unread-counts?user_id=${encodeURIComponent(userId)}`);
  },

  // ─── 搜索 ─────────────────────────────────────────────

  search(query: string, conversationId?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (conversationId) params.set("conversation_id", conversationId);
    return get(`/im/search?${params}`);
  },

  // ─── 表情回应 ──────────────────────────────────────────

  addReaction(messageId: number, userId: string, emoji: string) {
    return post<void>(`/im/messages/${messageId}/reactions`, { userId, emoji });
  },

  removeReaction(messageId: number, userId: string, emoji: string) {
    return post<void>(`/im/messages/${messageId}/reactions`, { userId, emoji, remove: true });
  },

  // ─── 置顶 / 静音 ──────────────────────────────────────

  pinConversation(conversationId: string, userId: string, pinned: boolean) {
    return post<void>(`/im/conversations/${conversationId}/pin`, { userId, pinned });
  },

  muteConversation(conversationId: string, userId: string, muted: boolean) {
    return post<void>(`/im/conversations/${conversationId}/mute`, { userId, muted });
  },

  // ─── 气泡拆分 ──────────────────────────────────────────

  splitPreview(content: string, maxBubbles = 4) {
    return post<{ parts: string[]; replyGroupId: string }>("/im/messages/split-preview", { content, maxBubbles });
  },

  sendSplitMessage(conversationId: string, senderId: string, content: string) {
    return post<{ replyGroupId: string; messages: ImMessage[] }>(
      `/im/conversations/${conversationId}/messages/split`,
      { senderId, content }
    );
  },

  // ─── 侧链 ─────────────────────────────────────────────

  createSidechain(conversationId: string) {
    return post<{ sidechainId: string }>(`/im/conversations/${conversationId}/sidechains`, {});
  },

  getSidechainMessages(conversationId: string, sidechainId: string) {
    return get<ImMessage[]>(`/im/conversations/${conversationId}/sidechains/${sidechainId}`);
  },

  listSidechains(conversationId: string) {
    return get<string[]>(`/im/conversations/${conversationId}/sidechains`);
  },

  // ─── Handoff ──────────────────────────────────────────

  handoffPreview(conversationId: string, sourceAgentId: string, targetAgent: "codex" | "claude-code", opts: { handoffNote?: string; projectPath?: string } = {}) {
    return post<{ snapshot: unknown; rendered: string }>("/im/handoffs/preview", {
      conversationId, sourceAgentId, targetAgent, ...opts,
    });
  },

  executeHandoff(conversationId: string, sourceAgentId: string, targetAgent: "codex" | "claude-code", opts: { handoffNote?: string; projectPath?: string } = {}) {
    return post<{ snapshot: unknown; renderedContent: string }>("/im/handoffs", {
      conversationId, sourceAgentId, targetAgent, ...opts,
    });
  },
};
