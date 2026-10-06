/**
 * IM Zustand Store
 *
 * 独立于主应用 store 的 IM 状态管理。
 * 包含：会话列表、当前会话消息、未读计数、搜索、WebSocket 事件处理。
 */

import { create } from "zustand";
import { imApi, type ImConversation, type ImMessage, type UnreadCount, type SearchResult } from "./imClient";

// ─── 状态类型 ───────────────────────────────────────────

interface ImState {
  /** 当前用户 ID */
  userId: string;

  /** 会话列表 */
  conversations: ImConversation[];
  conversationsLoading: boolean;

  /** 当前激活的会话 ID */
  activeConversationId: string | null;

  /** 当前会话的消息列表 */
  messages: ImMessage[];
  messagesLoading: boolean;
  messagesHasMore: boolean;
  messagesNextCursor: number | null;

  /** 各会话未读计数 */
  unreadCounts: Map<string, number>;

  /** 搜索结果 */
  searchResults: SearchResult[];
  searchQuery: string;
  searchLoading: boolean;

  /** WebSocket 连接状态 */
  wsConnected: boolean;

  /** 最近一次 IM 事件（供 UI 显示 toast） */
  lastEvent: { type: string; data: unknown } | null;
}

interface ImActions {
  // 初始化
  setUserId: (userId: string) => void;

  // 会话
  loadConversations: () => Promise<void>;
  setActiveConversation: (id: string | null) => void;

  // 消息
  loadMessages: (conversationId: string, opts?: { beforeSeq?: number }) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  appendMessage: (msg: ImMessage) => void;
  updateMessage: (messageId: number, updates: Partial<ImMessage>) => void;
  removeMessage: (messageId: number) => void;

  // 发送
  sendMessage: (content: string, opts?: { sidechainId?: string; replyGroupId?: string; replyToSeq?: number }) => Promise<void>;
  editMessage: (messageId: number, content: string) => Promise<void>;
  deleteMessage: (messageId: number) => Promise<void>;

  // 已读/未读
  markAsRead: (conversationId: string) => Promise<void>;
  loadUnreadCounts: () => Promise<void>;

  // 搜索
  search: (query: string, conversationId?: string) => Promise<void>;
  clearSearch: () => void;

  // 表情
  addReaction: (messageId: number, emoji: string) => Promise<void>;
  removeReaction: (messageId: number, emoji: string) => Promise<void>;

  // 置顶/静音
  pinConversation: (conversationId: string, pinned: boolean) => Promise<void>;
  muteConversation: (conversationId: string, muted: boolean) => Promise<void>;

  // WebSocket 事件
  setWsConnected: (connected: boolean) => void;
  handleImEvent: (type: string, data: unknown) => void;
}

export type ImStore = ImState & ImActions;

// ─── Store 创建 ─────────────────────────────────────────

export const useImStore = create<ImStore>((set, get) => ({
  // 初始状态
  userId: "default-user",
  conversations: [],
  conversationsLoading: false,
  activeConversationId: null,
  messages: [],
  messagesLoading: false,
  messagesHasMore: false,
  messagesNextCursor: null,
  unreadCounts: new Map(),
  searchResults: [],
  searchQuery: "",
  searchLoading: false,
  wsConnected: false,
  lastEvent: null,

  // ─── Actions ──────────────────────────────────────────

  setUserId: (userId) => set({ userId }),

  // 会话列表
  loadConversations: async () => {
    set({ conversationsLoading: true });
    try {
      const { userId } = get();
      const conversations = await imApi.listConversations(userId);
      set({ conversations, conversationsLoading: false });
    } catch (e) {
      console.error("[IM] loadConversations failed:", e);
      set({ conversationsLoading: false });
    }
  },

  setActiveConversation: (id) => {
    set({ activeConversationId: id, messages: [], messagesHasMore: false, messagesNextCursor: null });
    if (id) {
      get().loadMessages(id);
      get().markAsRead(id);
    }
  },

  // 消息
  loadMessages: async (conversationId, opts) => {
    set({ messagesLoading: true });
    try {
      const { userId } = get();
      const page = await imApi.getMessages(conversationId, {
        beforeSeq: opts?.beforeSeq,
        limit: 40,
        userId,
      });
      if (opts?.beforeSeq) {
        // 加载更多 → 追加到头部
        set((s) => ({
          messages: [...page.items, ...s.messages],
          messagesHasMore: page.hasMore,
          messagesNextCursor: page.nextCursor,
          messagesLoading: false,
        }));
      } else {
        // 首次加载 → 替换
        set({
          messages: page.items,
          messagesHasMore: page.hasMore,
          messagesNextCursor: page.nextCursor,
          messagesLoading: false,
        });
      }
    } catch (e) {
      console.error("[IM] loadMessages failed:", e);
      set({ messagesLoading: false });
    }
  },

  loadMoreMessages: async () => {
    const { activeConversationId, messagesNextCursor, messagesLoading } = get();
    if (!activeConversationId || messagesNextCursor == null || messagesLoading) return;
    await get().loadMessages(activeConversationId, { beforeSeq: messagesNextCursor });
  },

  appendMessage: (msg) => {
    set((s) => ({
      messages: [...s.messages, msg],
      // 更新会话的 latestSeq 和 preview
      conversations: s.conversations.map((c) =>
        c.id === msg.conversationId
          ? { ...c, latestSeq: msg.seq, preview: msg.content.slice(0, 200), updatedAt: msg.createdAt }
          : c
      ),
    }));
  },

  updateMessage: (messageId, updates) => {
    set((s) => ({
      messages: s.messages.map((m) => m.id === messageId ? { ...m, ...updates } : m),
    }));
  },

  removeMessage: (messageId) => {
    set((s) => ({
      messages: s.messages.filter((m) => m.id !== messageId),
    }));
  },

  // 发送消息
  sendMessage: async (content, opts) => {
    const { activeConversationId, userId } = get();
    if (!activeConversationId) return;

    try {
      const msg = await imApi.sendMessage(activeConversationId, {
        senderId: userId,
        content,
        sidechainId: opts?.sidechainId,
        replyGroupId: opts?.replyGroupId,
        replyToSeq: opts?.replyToSeq,
      });
      get().appendMessage(msg);
    } catch (e) {
      console.error("[IM] sendMessage failed:", e);
      throw e;
    }
  },

  editMessage: async (messageId, content) => {
    const { userId } = get();
    const msg = await imApi.editMessage(messageId, userId, content);
    get().updateMessage(messageId, { content: msg.content, editedAt: msg.editedAt });
  },

  deleteMessage: async (messageId) => {
    const { userId } = get();
    await imApi.deleteMessage(messageId, userId);
    get().removeMessage(messageId);
  },

  // 已读/未读
  markAsRead: async (conversationId) => {
    const { userId, messages } = get();
    const latestSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0;
    await imApi.markAsRead(conversationId, userId, latestSeq);

    set((s) => {
      const newCounts = new Map(s.unreadCounts);
      newCounts.set(conversationId, 0);
      return { unreadCounts: newCounts };
    });
  },

  loadUnreadCounts: async () => {
    try {
      const { userId } = get();
      const counts = await imApi.getUnreadCounts(userId);
      const map = new Map<string, number>();
      for (const c of counts) {
        if (c.unread > 0) map.set(c.conversationId, c.unread);
      }
      set({ unreadCounts: map });
    } catch (e) {
      console.error("[IM] loadUnreadCounts failed:", e);
    }
  },

  // 搜索
  search: async (query, conversationId) => {
    set({ searchLoading: true, searchQuery: query });
    try {
      const results = await imApi.search(query, conversationId);
      set({ searchResults: results, searchLoading: false });
    } catch (e) {
      console.error("[IM] search failed:", e);
      set({ searchLoading: false });
    }
  },

  clearSearch: () => set({ searchResults: [], searchQuery: "", searchLoading: false }),

  // 表情
  addReaction: async (messageId, emoji) => {
    const { userId } = get();
    await imApi.addReaction(messageId, userId, emoji);
    // 乐观更新
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m;
        const reactions = [...(m.reactions ?? [])];
        if (!reactions.some((r) => r.userOrBotId === userId && r.emoji === emoji)) {
          reactions.push({ messageId, userOrBotId: userId, emoji, createdAt: Date.now() });
        }
        return { ...m, reactions };
      }),
    }));
  },

  removeReaction: async (messageId, emoji) => {
    const { userId } = get();
    await imApi.removeReaction(messageId, userId, emoji);
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m;
        return { ...m, reactions: (m.reactions ?? []).filter((r) => !(r.userOrBotId === userId && r.emoji === emoji)) };
      }),
    }));
  },

  // 置顶/静音
  pinConversation: async (conversationId, pinned) => {
    const { userId } = get();
    await imApi.pinConversation(conversationId, userId, pinned);
    await get().loadConversations();
  },

  muteConversation: async (conversationId, muted) => {
    const { userId } = get();
    await imApi.muteConversation(conversationId, userId, muted);
  },

  // WebSocket
  setWsConnected: (connected) => set({ wsConnected: connected }),

  handleImEvent: (type, data) => {
    set({ lastEvent: { type, data } });
    const state = get();
    const eventData = data as Record<string, unknown>;

    switch (type) {
      case "im.message": {
        const convId = eventData.conversationId as string;
        if (convId === state.activeConversationId) {
          // 当前会话的新消息 → 追加
          const msg = eventData as unknown as ImMessage;
          if (msg.id && !state.messages.some((m) => m.id === msg.id)) {
            state.appendMessage(msg);
          }
        }
        // 更新未读计数
        state.loadUnreadCounts();
        break;
      }
      case "im.message.deleted": {
        const msgId = eventData.messageId as number;
        if (msgId) state.removeMessage(msgId);
        break;
      }
      case "im.message.edited": {
        const msgId = eventData.messageId as number;
        const content = eventData.content as string;
        if (msgId && content) {
          state.updateMessage(msgId, { content, editedAt: Date.now() });
        }
        break;
      }
      case "im.unread.update": {
        state.loadUnreadCounts();
        break;
      }
      case "im.reaction.added":
      case "im.reaction.removed": {
        // 刷新当前消息的 reactions
        const convId = eventData.conversationId as string;
        if (convId === state.activeConversationId) {
          state.loadMessages(convId);
        }
        break;
      }
    }
  },
}));
