/**
 * IM Inbox — Termany 风格收件箱
 *
 * 使用系统 CSS 变量匹配主题，设计参考 TabTin IM。
 * 三栏布局：搜索/会话列表 | 聊天区 | （可选）详情面板
 *
 * 优化项：
 * - 新建会话按钮（DM / 群组）
 * - 消息列表虚拟化（只渲染可视区域 ± 缓冲）
 * - Typing 指示器
 * - 日期分隔线
 * - 消息复制 / 右键菜单
 * - 搜索结果高亮跳转
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useImStore } from "../imStore";
import { useImWebSocket } from "../useImWebSocket";
import { imApi, type ImConversation, type ImMessage } from "../imClient";
import { SearchIcon, SendIcon, CloseIcon } from "./icons";
import { useStore } from "../state/store";

// ─── 常量 ──────────────────────────────────────────────

/** 虚拟化：每条消息的预估高度（px） */
const ESTIMATED_MSG_HEIGHT = 72;
/** 虚拟化：可视区外缓冲条数 */
const OVERSCAN = 5;
/** 新建会话 dialog 的 tab 类型 */
type NewConvTab = "dm" | "group";

// ─── 主组件 ─────────────────────────────────────────────

interface InboxProps {
  serverPort?: number;
}

export function Inbox({ serverPort = 5175 }: InboxProps) {
  const {
    conversations, activeConversationId, messages,
    unreadCounts, searchResults, searchQuery, typingUsers,
    wsConnected, conversationsLoading, messagesLoading,
    loadConversations, setActiveConversation, loadMoreMessages,
    sendMessage, editMessage, deleteMessage,
    markAsRead, loadUnreadCounts,
    search, clearSearch,
    addReaction, removeReaction,
    setUserId,
  } = useImStore();

  const { subscribe, unsubscribe, sendTyping } = useImWebSocket(serverPort);

  // 从主 store 同步 userId（不再硬编码 "default-user"）
  const userNickname = useStore((s) => s.userProfile.nickname);
  useEffect(() => {
    const id = userNickname?.trim() || "default-user";
    setUserId(id);
  }, [userNickname, setUserId]);

  useEffect(() => {
    loadConversations();
    loadUnreadCounts();
  }, [loadConversations, loadUnreadCounts]);

  // 订阅所有会话频道
  useEffect(() => {
    if (conversations.length === 0) return;
    conversations.forEach((conv) => {
      subscribe(`conversation:${conv.id}`);
    });
    return () => {
      conversations.forEach((conv) => {
        unsubscribe(`conversation:${conv.id}`);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  const [inputValue, setInputValue] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [highlightedMsgId, setHighlightedMsgId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // ─── 消息列表虚拟化 ──────────────────────────────────

  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 40 });

  const handleVirtualScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el || messages.length === 0) return;
    const { scrollTop, clientHeight } = el;
    const totalHeight = messages.length * ESTIMATED_MSG_HEIGHT;

    // 计算可视区域
    const startIdx = Math.max(0, Math.floor(scrollTop / ESTIMATED_MSG_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(clientHeight / ESTIMATED_MSG_HEIGHT) + OVERSCAN * 2;
    const endIdx = Math.min(messages.length, startIdx + visibleCount);

    setVisibleRange((prev) => {
      if (prev.start === startIdx && prev.end === endIdx) return prev;
      return { start: startIdx, end: endIdx };
    });

    // 滚到顶部 → 加载更多
    if (scrollTop < 50 && !messagesLoading) {
      loadMoreMessages();
    }
  }, [messages.length, messagesLoading, loadMoreMessages]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleVirtualScroll, { passive: true });
    // 初始计算
    handleVirtualScroll();
    return () => el.removeEventListener("scroll", handleVirtualScroll);
  }, [handleVirtualScroll]);

  // 新消息 → 自动滚动到底部
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

  // 搜索结果跳转：加载目标消息所在的分页，滚动到它并高亮
  const jumpToSearchResult = useCallback(async (result: { messageId: number; conversationId: string; seq: number }) => {
    // 如果不在同一个会话，先切换
    if (result.conversationId !== activeConversationId) {
      setActiveConversation(result.conversationId);
    }
    // 加载目标消息附近的分页
    try {
      const page = await imApi.getMessages(result.conversationId, {
        beforeSeq: result.seq + 1,
        limit: 40,
        userId: useImStore.getState().userId,
      });
      useImStore.setState({
        messages: page.items,
        messagesHasMore: page.hasMore,
        messagesNextCursor: page.nextCursor,
        messagesLoading: false,
      });
      // 高亮目标消息（3秒后自动取消）
      setHighlightedMsgId(result.messageId);
      setTimeout(() => setHighlightedMsgId(null), 3000);
      // 滚动到目标位置
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-msg-id="${result.messageId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    } catch (e) {
      console.error("[IM] jump to search result failed:", e);
    }
  }, [activeConversationId, setActiveConversation]);

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const totalUnread = Array.from(unreadCounts.values()).reduce((sum, n) => sum + n, 0);

  // Typing 指示器
  const activeTypingUsers = useMemo(() => {
    const now = Date.now();
    return Array.from(typingUsers.entries())
      .filter(([, expires]) => expires > now)
      .map(([uid]) => uid);
  }, [typingUsers]);

  // 虚拟化切片
  const visibleMessages = messages.slice(visibleRange.start, visibleRange.end);
  const topPadding = visibleRange.start * ESTIMATED_MSG_HEIGHT;
  const bottomPadding = (messages.length - visibleRange.end) * ESTIMATED_MSG_HEIGHT;

  return (
    <div className="im-inbox">
      {/* ─── 左栏：会话列表 ─── */}
      <aside className="im-sidebar">
        <div className="im-sidebar-header">
          <h2 className="im-sidebar-title">消息</h2>
          <div className="im-sidebar-actions">
            {totalUnread > 0 && (
              <span className="im-sidebar-badge">{totalUnread > 99 ? "99+" : totalUnread}</span>
            )}
            <button
              className="im-new-conv-btn"
              onClick={() => setNewConvOpen(true)}
              title="新建会话"
            >
              ✏️
            </button>
          </div>
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
              <button
                className="im-empty-create-btn"
                onClick={() => setNewConvOpen(true)}
              >
                + 创建第一个会话
              </button>
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
            <button
              className="im-empty-create-btn"
              onClick={() => setNewConvOpen(true)}
            >
              + 新建会话
            </button>
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
                <div className="im-search-results-inline">
                  {searchResults.slice(0, 5).map((r) => (
                    <button
                      key={r.messageId}
                      className="im-search-result-chip"
                      onClick={() => jumpToSearchResult(r)}
                      title={r.content.slice(0, 80)}
                    >
                      #{r.seq} {r.content.slice(0, 30)}{r.content.length > 30 ? "..." : ""}
                    </button>
                  ))}
                </div>
                <button onClick={clearSearch}><CloseIcon /> 清除</button>
              </div>
            )}

            <div className="im-messages" ref={messagesContainerRef}>
              {messagesLoading && (
                <div className="im-loading-hint">加载中...</div>
              )}

              {/* 虚拟化顶部占位 */}
              {topPadding > 0 && <div style={{ height: topPadding }} />}

              {visibleMessages.map((msg, idx) => {
                const globalIdx = visibleRange.start + idx;
                const showDateSep = shouldShowDateSep(messages, globalIdx);
                return (
                  <div key={msg.id}>
                    {showDateSep && <DateSeparator timestamp={msg.createdAt} />}
                    <MessageBubble
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
                      highlighted={highlightedMsgId === msg.id}
                      onJumpToSearchResult={undefined}
                    />
                  </div>
                );
              })}

              {/* Typing 指示器 */}
              {activeTypingUsers.length > 0 && (
                <div className="im-typing-indicator">
                  <span className="im-typing-dots">
                    <span /><span /><span />
                  </span>
                  {activeTypingUsers.join(", ")} 正在输入...
                </div>
              )}

              {/* 虚拟化底部占位 */}
              {bottomPadding > 0 && <div style={{ height: bottomPadding }} />}
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

      {/* ─── 新建会话 Dialog ─── */}
      {newConvOpen && (
        <NewConversationDialog
          onClose={() => setNewConvOpen(false)}
          userId={useImStore.getState().userId}
          onCreated={(convId) => {
            setNewConvOpen(false);
            setActiveConversation(convId);
          }}
        />
      )}
    </div>
  );
}

// ─── 新建会话 Dialog ────────────────────────────────────

function NewConversationDialog({ onClose, onCreated, userId }: {
  onClose: () => void;
  onCreated: (convId: string) => void;
  userId: string;
}) {
  const [tab, setTab] = useState<NewConvTab>("dm");
  const [targetId, setTargetId] = useState("");
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMembers, setGroupMembers] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (tab === "dm") {
        if (!targetId.trim()) { setError("请输入对方 ID"); setLoading(false); return; }
        const conv = await imApi.createDm(userId, targetId.trim());
        onCreated(conv.id);
      } else {
        if (!groupTitle.trim()) { setError("请输入群组名称"); setLoading(false); return; }
        const members = groupMembers.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
          .map((id) => ({ id, type: "user" as const }));
        const conv = await imApi.createGroup(
          groupTitle.trim(),
          userId,
          [{ id: userId, type: "user", role: "owner" }, ...members]
        );
        onCreated(conv.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setLoading(false);
    }
  }, [tab, targetId, groupTitle, groupMembers, userId, onCreated]);

  return (
    <div className="im-dialog-overlay" onClick={onClose}>
      <div className="im-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="im-dialog-header">
          <h3>新建会话</h3>
          <button className="im-dialog-close" onClick={onClose}><CloseIcon /></button>
        </div>

        <div className="im-dialog-tabs">
          <button
            className={`im-dialog-tab${tab === "dm" ? " active" : ""}`}
            onClick={() => setTab("dm")}
          >
            私聊
          </button>
          <button
            className={`im-dialog-tab${tab === "group" ? " active" : ""}`}
            onClick={() => setTab("group")}
          >
            群组
          </button>
        </div>

        <div className="im-dialog-body">
          {tab === "dm" ? (
            <div className="im-dialog-field">
              <label>对方用户 ID</label>
              <input
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                placeholder="输入用户 ID（如 user-b）"
                autoFocus
              />
            </div>
          ) : (
            <>
              <div className="im-dialog-field">
                <label>群组名称</label>
                <input
                  value={groupTitle}
                  onChange={(e) => setGroupTitle(e.target.value)}
                  placeholder="输入群组名称"
                  autoFocus
                />
              </div>
              <div className="im-dialog-field">
                <label>成员 ID（逗号或换行分隔）</label>
                <textarea
                  value={groupMembers}
                  onChange={(e) => setGroupMembers(e.target.value)}
                  placeholder="user-a&#10;user-b"
                  rows={3}
                />
              </div>
            </>
          )}

          {error && <div className="im-dialog-error">{error}</div>}
        </div>

        <div className="im-dialog-footer">
          <button onClick={onClose}>取消</button>
          <button
            className="im-dialog-primary"
            onClick={handleCreate}
            disabled={loading}
          >
            {loading ? "创建中..." : "创建"}
          </button>
        </div>
      </div>
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

function MessageBubble({ msg, isOwn, isEditing, editContent, onEditContentChange, onStartEdit, onCancelEdit, onConfirmEdit, onDelete, onReaction, onRemoveReaction, highlighted }: {
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
  onJumpToSearchResult?: (() => void) | undefined;
  highlighted?: boolean;
}) {
  const [showActions, setShowActions] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  if (msg.isDeleted) {
    return <div className="im-msg-deleted">消息已撤回</div>;
  }

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(msg.content).catch(() => {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = msg.content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    });
    setContextMenu(null);
  }, [msg.content]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <div
      className={`im-msg-wrapper${isOwn ? " own" : ""}${highlighted ? " highlighted" : ""}`}
      data-msg-id={msg.id}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onContextMenu={handleContextMenu}
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
          <button onClick={handleCopy} title="复制">📋</button>
          {isOwn && (
            <>
              <button onClick={onStartEdit} title="编辑">✏️</button>
              <button onClick={onDelete} title="撤回">🗑️</button>
            </>
          )}
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <>
          <div className="im-context-backdrop" onClick={closeContextMenu} />
          <div
            className="im-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button onClick={handleCopy}>📋 复制文本</button>
            {isOwn && (
              <>
                <button onClick={() => { onStartEdit(); closeContextMenu(); }}>✏️ 编辑</button>
                <button onClick={() => { onDelete(); closeContextMenu(); }}>🗑️ 撤回</button>
              </>
            )}
          </div>
        </>
      )}

      <div className="im-msg-meta">
        {formatTime(msg.createdAt)}
        {msg.replyGroupId && <span title="气泡组"> 🔗</span>}
        {msg.sidechainId && <span title="侧链"> 🔀</span>}
      </div>
    </div>
  );
}

// ─── 日期分隔线 ─────────────────────────────────────────

function DateSeparator({ timestamp }: { timestamp: number }) {
  return (
    <div className="im-date-separator">
      <span>{formatDateSep(timestamp)}</span>
    </div>
  );
}

function shouldShowDateSep(messages: ImMessage[], idx: number): boolean {
  if (idx === 0) return true;
  const prev = messages[idx - 1].createdAt;
  const curr = messages[idx].createdAt;
  const prevDay = new Date(prev).toDateString();
  const currDay = new Date(curr).toDateString();
  return prevDay !== currDay;
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

function formatDateSep(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays}天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function groupByEmoji(reactions: Array<{ emoji: string }>): Array<{ emoji: string; count: number }> {
  const map = new Map<string, number>();
  for (const r of reactions) map.set(r.emoji, (map.get(r.emoji) ?? 0) + 1);
  return Array.from(map, ([emoji, count]) => ({ emoji, count }));
}
