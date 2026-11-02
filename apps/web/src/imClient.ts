/**
 * Termany IM API 客户端
 *
 * 封装后端 IM REST API，供前端组件调用。
 * 所有方法返回 Promise，错误统一抛 Error。
 */

import { apiPath } from "./api";
import type { ImTask, ImExecutionSettings, ImAttachment } from "@termany/core";

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

export interface ImContact { id: string; name: string; type: "user" | "bot" }
export interface ImCapabilities { llmConfigured: boolean; agents: Array<{ id: string; available: boolean; reason?: string }> }
export interface ImMember { conversationId: string; userOrBotId: string; memberType: "user" | "bot"; role: "owner" | "admin" | "member"; joinedAt: number }
export interface ImHandoffPreview {
  previewId: string;
  snapshot: { snapshotId: string; requestedMode: "rules" | "llm"; distillMode: "rules" | "llm"; warnings: string[] };
  rendered: string;
}
export interface ImHandoffResult { taskId: string; targetConversationId: string; status: string; renderedContent: string }
export interface ImHandoffOptions { userId?: string; handoffNote?: string; projectPath?: string; mode?: "rules" | "llm"; previewId?: string }

export interface ImMessage {
  id: number;
  conversationId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  senderType: "user" | "agent" | "system";
  senderId: string;
  content: string;
  messageType: "text" | "file" | "image" | "system";
  metadata: Record<string, unknown> & { attachments?: ImAttachment[] };
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
  async uploadAttachment(conversationId: string, userId: string, file: File): Promise<ImAttachment> {
    if (file.size > 10 * 1024 * 1024 || !file.size) throw new Error("附件大小需为 1 字节至 10 MB");
    return request(`/im/conversations/${conversationId}/attachments?user_id=${encodeURIComponent(userId)}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file,
    });
  },
  attachmentUrl(id: string, userId: string, preview = false) {
    return imPath(`/im/attachments/${encodeURIComponent(id)}${preview ? "/preview" : ""}?user_id=${encodeURIComponent(userId)}`);
  },
  listTasks(conversationId: string, userId: string) {
    return get<ImTask[]>(`/im/conversations/${conversationId}/tasks?user_id=${encodeURIComponent(userId)}`);
  },
  cancelTask(id: string, userId: string) { return post<void>(`/im/tasks/${id}/cancel`, { userId }); },
  retryTask(id: string, userId: string) { return post<ImTask>(`/im/tasks/${id}/retry`, { userId }); },
  respondTaskPermission(id: string, userId: string, requestId: string, optionId: string) {
    return post<void>(`/im/tasks/${id}/permission`, { userId, requestId, optionId });
  },
  executionSettings(conversationId: string, userId: string) {
    return get<ImExecutionSettings>(`/im/conversations/${conversationId}/execution-settings?user_id=${encodeURIComponent(userId)}`);
  },
  configureExecution(conversationId: string, userId: string, settings: ImExecutionSettings) {
    return put<ImExecutionSettings>(`/im/conversations/${conversationId}/execution-settings`, { userId, settings });
  },
  listContacts(): Promise<ImContact[]> { return get("/im/contacts"); },
  capabilities(): Promise<ImCapabilities> { return get("/im/capabilities"); },
  changeMember(conversationId: string, userId: string, targetId: string, remove = false) {
    return request<ImMember[]>(`/im/conversations/${conversationId}/members`, { method: remove ? "DELETE" : "POST", body: JSON.stringify({ userId, targetId }) });
  },
  listMembers(conversationId: string, userId: string): Promise<ImMember[]> {
    return get(`/im/conversations/${conversationId}/members?user_id=${encodeURIComponent(userId)}`);
  },
  pinMessage(messageId: number, pinned: boolean, userId = "default-user") {
    return post<void>(`/im/messages/${messageId}/pin`, { pinned, userId });
  },
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
    attachmentIds?: string[];
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
      attachmentIds: opts.attachmentIds,
      messageType: opts.attachmentIds?.length ? "file" : "text",
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

  search(query: string, conversationId?: string, userId = "default-user"): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (conversationId) params.set("conversation_id", conversationId);
    params.set("user_id", userId);
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

  createSidechain(conversationId: string, userId = "default-user") {
    return post<{ sidechainId: string }>(`/im/conversations/${conversationId}/sidechains?user_id=${encodeURIComponent(userId)}`, {});
  },

  getSidechainMessages(conversationId: string, sidechainId: string, userId = "default-user") {
    return get<ImMessage[]>(`/im/conversations/${conversationId}/sidechains/${sidechainId}?user_id=${encodeURIComponent(userId)}`);
  },

  listSidechains(conversationId: string, userId = "default-user") {
    return get<string[]>(`/im/conversations/${conversationId}/sidechains?user_id=${encodeURIComponent(userId)}`);
  },

  // ─── Handoff ──────────────────────────────────────────

  handoffPreview(conversationId: string, sourceAgentId: string, targetAgent: string, opts: ImHandoffOptions = {}) {
    return post<ImHandoffPreview>("/im/handoffs/preview", {
      conversationId, sourceAgentId, targetAgent, ...opts,
    });
  },

  executeHandoff(conversationId: string, sourceAgentId: string, targetAgent: string, opts: ImHandoffOptions = {}) {
    return post<ImHandoffResult>("/im/handoffs", {
      conversationId, sourceAgentId, targetAgent, ...opts,
    });
  },
  listHandoffs(conversationId: string, userId: string) {
    return get<Array<ImHandoffResult & { snapshot: { snapshotId: string; target: string } }>>(`/im/handoffs?conversation_id=${encodeURIComponent(conversationId)}&user_id=${encodeURIComponent(userId)}`);
  },
};
