/**
 * IM ↔ Zustand Store 桥接层
 *
 * 把后端 IM API 的数据同步到现有 Zustand store（agentConversations）。
 * AgentWorkspace / AgentPane 继续读 store，无需改动。
 * 写操作同时更新 store + 调 IM API（双向同步）。
 *
 * 使用方式：在 App 顶层调用 useImBridge()，一次挂载即可。
 */

import { useEffect, useRef, useCallback } from "react";
import { useStore, type AgentConversation, type AgentMessage } from "./state/store";
import { imApi, type ImConversation, type ImMessage } from "./imClient";

/** IM 会话 → AgentConversation 的字段映射 */
function imConvToAgentConv(im: ImConversation, existing?: AgentConversation): AgentConversation {
  return {
    // 保留现有 AgentConversation 的扩展字段（runtime, avatar, tags 等）
    ...(existing ?? {}),
    // 核心字段从 IM 覆盖
    id: im.id,
    kind: "leaf" as const,
    title: im.title || `Conversation ${im.id.slice(0, 8)}`,
    view: "agent" as const,
    createdAt: im.createdAt,
    updatedAt: im.updatedAt,
    agentPinned: false, // TODO: 从 IM state 读取
    agentUnread: 0,     // 由 unreadCounts 驱动
    // IM 特有字段透传（供后续 UI 使用）
    agentDescription: im.type === "group" ? `${im.memberCount} members` : "DM",
    // 占位字段（AgentConversation 类型需要）
    cwdFrom: undefined,
    sshTarget: undefined,
  } as AgentConversation;
}

/** IM 消息 → AgentMessage 的字段映射 */
function imMsgToAgentMsg(im: ImMessage): AgentMessage {
  return {
    id: String(im.id),
    role: im.role === "assistant" ? "assistant" : "user",
    content: im.content,
    createdAt: im.createdAt,
    replyGroupId: im.replyGroupId ?? undefined,
    sender: im.senderType === "agent"
      ? { id: im.senderId, name: im.senderId }
      : undefined,
  };
}

/**
 * IM 桥接 Hook
 *
 * 职责：
 * 1. 启动时从 IM API 加载会话列表 → 同步到 store
 * 2. 监听 WebSocket 事件 → 增量更新 store
 * 3. 提供 sendSync / markReadSync 等方法供组件调用
 *
 * 注意：不再创建 WebSocket 连接，由 Inbox 组件统一管理
 */
export function useImBridge() {
  const userId = "default-user"; // TODO: 从 store.userProfile 读取
  const syncingRef = useRef(false);

  const addConversation = useStore((s) => s.addAgentConversation);
  const setAgentMessages = useStore((s) => s.setAgentMessages);
  const markRead = useStore((s) => s.markAgentConversationRead);

  // ─── 全量同步：IM API → store ────────────────────────

  const syncConversations = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;

    try {
      const imConvs = await imApi.listConversations(userId);
      const currentConvs = useStore.getState().agentConversations;
      const currentMap = new Map(currentConvs.map((c) => [c.id, c]));

      for (const imConv of imConvs) {
        const existing = currentMap.get(imConv.id);
        const agentConv = imConvToAgentConv(imConv, existing);

        if (!existing) {
          // 新会话 → 添加到 store
          addConversation(agentConv);
          // 订阅该会话的 WebSocket 频道
          ws.subscribe(`conversation:${imConv.id}`);
        }
        // 已有会话 → 暂不覆盖（保留用户自定义的 avatar/tags 等）
      }
    } catch (e) {
      console.error("[IM Bridge] sync conversations failed:", e);
    } finally {
      syncingRef.current = false;
    }
  }, [userId, addConversation, ws]);

  // ─── 消息同步：IM API → store ────────────────────────

  const syncMessages = useCallback(async (conversationId: string) => {
    try {
      const page = await imApi.getMessages(conversationId, { limit: 100, userId });
      const agentMsgs = page.items.map(imMsgToAgentMsg);
      setAgentMessages(conversationId, agentMsgs);
    } catch (e) {
      console.error("[IM Bridge] sync messages failed:", e);
    }
  }, [userId, setAgentMessages]);

  // ─── 发送消息：store + IM API 双写 ────────────────────

  const sendMessageSync = useCallback(async (
    conversationId: string,
    content: string,
    opts?: { sidechainId?: string; replyGroupId?: string }
  ) => {
    try {
      const imMsg = await imApi.sendMessage(conversationId, {
        senderId: userId,
        content,
        sidechainId: opts?.sidechainId,
        replyGroupId: opts?.replyGroupId,
      });

      // 同步到 store
      const currentMsgs = useStore.getState().agentConversations
        .find((c) => c.id === conversationId);
      // setAgentMessages 会覆盖，所以需要追加
      const agentMsg = imMsgToAgentMsg(imMsg);
      // TODO: 追加到现有消息列表而非覆盖

      return agentMsg;
    } catch (e) {
      console.error("[IM Bridge] send message failed:", e);
      throw e;
    }
  }, [userId]);

  // ─── 标记已读：store + IM API 双写 ────────────────────

  const markReadSync = useCallback(async (conversationId: string) => {
    // 先更新 store
    markRead(conversationId);

    // 再通知后端
    try {
      const msgs = useStore.getState().agentConversations
        .find((c) => c.id === conversationId);
      // 用最新消息的 seq
      await imApi.markAsRead(conversationId, userId, Date.now());
    } catch (e) {
      console.error("[IM Bridge] mark read failed:", e);
    }
  }, [userId, markRead]);

  // ─── 编辑/撤回 ────────────────────────────────────────

  const editMessageSync = useCallback(async (messageId: number, content: string) => {
    await imApi.editMessage(messageId, userId, content);
    // store 会通过 WebSocket 事件自动更新
  }, [userId]);

  const deleteMessageSync = useCallback(async (messageId: number) => {
    await imApi.deleteMessage(messageId, userId);
    // store 会通过 WebSocket 事件自动更新
  }, [userId]);

  // ─── WebSocket 事件 → store 增量更新 ──────────────────

  useEffect(() => {
    // 监听 IM 事件，增量更新 store
    const state = useStore.getState();
    // TODO: 注册事件监听器（当 imStore 收到事件时，同步到主 store）

    return () => {
      // 清理监听器
    };
  }, []);

  // ─── 启动时全量同步 ──────────────────────────────────

  useEffect(() => {
    syncConversations();
  }, [syncConversations]);

  return {
    syncConversations,
    syncMessages,
    sendMessageSync,
    markReadSync,
    editMessageSync,
    deleteMessageSync,
    wsConnected: ws !== null,
  };
}
