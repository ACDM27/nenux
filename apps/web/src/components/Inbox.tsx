/**
 * IM Inbox — Termany 风格收件箱
 *
 * 使用系统 CSS 变量匹配主题，设计参考 TabTin IM。
 * 三栏布局：搜索/会话列表 | 聊天区 | （可选）详情面板
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useImStore } from "../imStore";
import { useImWebSocket } from "../useImWebSocket";
import type { ImConversation, ImMessage } from "../imClient";
import { SearchIcon, SendIcon, CloseIcon } from "./icons";

// ─── 主组件 ─────────────────────────────────────────────

interface InboxProps {
  serverPort?: number;
}

export function Inbox({ serverPort = 5175 }: InboxProps) {
  const {
    conversations, activeConversationId, messages,
    unreadCounts, searchResults, searchQuery,
    wsConnected, conversationsLoading, messagesLoading,
    loadConversations, setActiveConversation, loadMoreMessages,
    sendMessage, editMessage, deleteMessage,
    markAsRead, loadUnreadCounts,
    search, clearSearch,
    addReaction, removeReaction,
  } = useImStore();

  const { subscribe, unsubscribe, sendTyping } = useImWebSocket(serverPort);

  useEffect(() => {
    loadConversations();
    loadUnreadCounts();
  }, [loadConversations, loadUnreadCounts]);

  // 订阅所有会话频道（启动时 + 会话列表变化时）
  useEffect(() => {
    // 只在有会话时才订阅
    if (conversations.length === 0) {
      console.log("[IM Inbox] ⏳ No conversations yet, skipping subscribe");
      return; // 返回空的 cleanup 函数
    }

    console.log("[IM Inbox] 📡 Subscribing to conversations:", conversations.map(c => c.id));
    conversations.forEach((conv) => {
      subscribe(`conversation:${conv.id}`);
    });

    return () => {
      // 只在确实订阅过的情况下才取消订阅
      console.log("[IM Inbox] 🔄 Cleanup: unsubscribing from conversations");
      conversations.forEach((conv) => {
        unsubscribe(`conversation:${conv.id}`);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]); // 只依赖 conversations，不依赖 subscribe/unsubscribe

  const [inputValue, setInputValue] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!inputValue.trim()) return;
    try {
      await sendMessage(inputValue.trim());
      setInputValue("");
    } catch (e) {
      console.error("Send failed:", e);
    }
  }, [inputValue, sendMessage]);

  const handleEdit = useCallback(async (messageId: number) => {
    if (!editContent.trim()) return;
    await editMessage(messageId, editContent.trim());
    setEditingId(null);
    setEditContent("");
  }, [editContent, editMessage]);

  const handleSearch = useCallback(() => {
    if (searchInput.trim()) {
      search(searchInput.trim(), activeConversationId ?? undefined);
    } else {
      clearSearch();
    }
  }, [searchInput, search, clearSearch, activeConversationId]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop } = e.currentTarget;
    if (scrollTop < 50 && !messagesLoading) {
      loadMoreMessages();
    }
  }, [loadMoreMessages, messagesLoading]);

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const totalUnread = Array.from(unreadCounts.values()).reduce((sum, n) => sum + n, 0);

  return (
    <div className="im-inbox">
      {/* ─── 左栏：会话列表 ─── */}
      <aside className="im-sidebar">
        <div className="im-sidebar-header">
          <h2 className="im-sidebar-title">消息</h2>
          {totalUnread > 0 && (
            <span className="im-sidebar-badge">{totalUnread > 99 ? "99+" : totalUnread}</span>
          )}
        </div>

        <div className="im-search">
          <SearchIcon />
          <input
            placeholder="搜索消息..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>

        <div className="im-connection-status" data-connected={wsConnected}>
          {wsConnected ? "已连接" : "未连接"}
        </div>

        <div className="im-conversation-list">
          {conversationsLoading && (
            <div className="im-empty-hint">加载中...</div>
          )}
          {conversations.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              isActive={conv.id === activeConversationId}
              unread={unreadCounts.get(conv.id) ?? 0}
              onClick={() => setActiveConversation(conv.id)}
            />
          ))}
          {!conversationsLoading && conversations.length === 0 && (
            <div className="im-empty-hint">
              <p>暂无会话</p>
              <p className="im-empty-sub">通过 API 创建 DM 或群组开始</p>
            </div>
          )}
        </div>
      </aside>

      {/* ─── 中栏：聊天区 ─── */}
      <main className="im-chat">
        {!activeConv ? (
          <div className="im-chat-empty">
            <div className="im-chat-empty-icon">💬</div>
            <p>选择一个会话开始聊天</p>
          </div>
        ) : (
          <>
            <header className="im-chat-header">
              <div className="im-chat-header-info">
                <h3>{activeConv.title || `对话 ${activeConv.id.slice(0, 8)}`}</h3>
                <span className="im-chat-header-meta">
                  {activeConv.type === "group" ? `${activeConv.memberCount} 成员` : "私聊"}
                </span>
              </div>
            </header>

            {searchQuery && (
              <div className="im-search-banner">
                <span>搜索 "{searchQuery}" — {searchResults.length} 条结果</span>
                <button onClick={clearSearch}><CloseIcon /> 清除</button>
              </div>
            )}

            <div className="im-messages" onScroll={handleScroll}>
              {messagesLoading && (
                <div className="im-loading-hint">加载中...</div>
              )}
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  isOwn={msg.senderType === "user"}
                  isEditing={editingId === msg.id}
                  editContent={editContent}
                  onEditContentChange={setEditContent}
                  onStartEdit={() => { setEditingId(msg.id); setEditContent(msg.content); }}
                  onCancelEdit={() => { setEditingId(null); setEditContent(""); }}
                  onConfirmEdit={() => handleEdit(msg.id)}
                  onDelete={() => deleteMessage(msg.id)}
                  onReaction={(emoji) => addReaction(msg.id, emoji)}
                  onRemoveReaction={(emoji) => removeReaction(msg.id, emoji)}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <footer className="im-composer">
              <div className="im-composer-input">
                <input
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    if (activeConversationId) {
                      sendTyping(`conversation:${activeConversationId}`);
                    }
                  }}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                  placeholder="输入消息..."
                />
                <button
                  onClick={handleSend}
                  disabled={!inputValue.trim()}
                  className="im-send-btn"
                  data-active={!!inputValue.trim()}
                >
                  <SendIcon />
                </button>
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

// ─── 会话行 ─────────────────────────────────────────────

function ConversationRow({ conv, isActive, unread, onClick }: {
  conv: ImConversation;
  isActive: boolean;
  unread: number;
  onClick: () => void;
}) {
  return (
    <div
      className={`im-conv-row${isActive ? " active" : ""}`}
      onClick={onClick}
    >
      <div className={`im-conv-avatar ${conv.type}`}>
        {conv.type === "group" ? "👥" : "💬"}
      </div>
      <div className="im-conv-body">
        <div className="im-conv-top">
          <span className="im-conv-name">{conv.title || conv.id.slice(0, 12)}</span>
          {unread > 0 && <span className="im-conv-unread">{unread > 99 ? "99+" : unread}</span>}
        </div>
        <div className="im-conv-preview">{conv.preview || "暂无消息"}</div>
      </div>
    </div>
  );
}

// ─── 消息气泡 ───────────────────────────────────────────

function MessageBubble({ msg, isOwn, isEditing, editContent, onEditContentChange, onStartEdit, onCancelEdit, onConfirmEdit, onDelete, onReaction, onRemoveReaction }: {
  msg: ImMessage;
  isOwn: boolean;
  isEditing: boolean;
  editContent: string;
  onEditContentChange: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onConfirmEdit: () => void;
  onDelete: () => void;
  onReaction: (emoji: string) => void;
  onRemoveReaction: (emoji: string) => void;
}) {
  const [showActions, setShowActions] = useState(false);

  if (msg.isDeleted) {
    return <div className="im-msg-deleted">消息已撤回</div>;
  }

  return (
    <div
      className={`im-msg-wrapper${isOwn ? " own" : ""}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {msg.senderType === "agent" && (
        <div className="im-msg-sender">🤖 {msg.senderId}</div>
      )}

      <div className={`im-bubble${isOwn ? " own" : ""}`}>
        {isEditing ? (
          <div className="im-edit-box">
            <input
              value={editContent}
              onChange={(e) => onEditContentChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onConfirmEdit();
                if (e.key === "Escape") onCancelEdit();
              }}
              autoFocus
            />
            <div className="im-edit-actions">
              <button onClick={onConfirmEdit}>保存</button>
              <button onClick={onCancelEdit}>取消</button>
            </div>
          </div>
        ) : (
          <div className="im-bubble-content">
            <span className="im-bubble-text">{msg.content}</span>
            {msg.editedAt && <span className="im-bubble-edited">(已编辑)</span>}
          </div>
        )}

        {msg.reactions && msg.reactions.length > 0 && (
          <div className="im-reactions">
            {groupByEmoji(msg.reactions).map(({ emoji, count }) => (
              <button
                key={emoji}
                className="im-reaction-chip"
                onClick={() => {
                  const mine = msg.reactions!.some((r) => r.emoji === emoji);
                  mine ? onRemoveReaction(emoji) : onReaction(emoji);
                }}
              >
                {emoji} {count}
              </button>
            ))}
          </div>
        )}
      </div>

      {showActions && !isEditing && (
        <div className="im-msg-actions">
          <button onClick={() => onReaction("👍")} title="点赞">👍</button>
          <button onClick={() => onReaction("❤️")} title="爱心">❤️</button>
          {isOwn && (
            <>
              <button onClick={onStartEdit} title="编辑">✏️</button>
              <button onClick={onDelete} title="撤回">🗑️</button>
            </>
          )}
        </div>
      )}

      <div className="im-msg-meta">
        {formatTime(msg.createdAt)}
        {msg.replyGroupId && <span title="气泡组"> 🔗</span>}
        {msg.sidechainId && <span title="侧链"> 🔀</span>}
      </div>
    </div>
  );
}

// ─── 工具函数 ───────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - ts) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function groupByEmoji(reactions: Array<{ emoji: string }>): Array<{ emoji: string; count: number }> {
  const map = new Map<string, number>();
  for (const r of reactions) map.set(r.emoji, (map.get(r.emoji) ?? 0) + 1);
  return Array.from(map, ([emoji, count]) => ({ emoji, count }));
}
