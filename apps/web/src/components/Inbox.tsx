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
import { apiPath } from "../api";

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
    userId,
    loadConversations, setActiveConversation, loadMoreMessages,
    sendMessage, editMessage, deleteMessage,
    loadUnreadCounts,
    search, clearSearch,
    addReaction, removeReaction,
    setUserId,
  } = useImStore();

  const { subscribe, unsubscribe, sendTyping } = useImWebSocket(serverPort);

  // 当前会话是否群组
  const isGroupChat = conversations.find(c => c.id === activeConversationId)?.type === "group";

  // 侧栏 Tab
  const [sidebarTab, setSidebarTab] = useState<"chats" | "contacts" | "groups">("chats");

  // 从会话中提取所有已知用户
  const knownUsers = useMemo(() => {
    const userSet = new Set<string>();
    conversations.forEach(_conv => {
      // 从成员列表中提取（需要 imStore 提供成员信息）
    });
    // 至少包含当前用户
    userSet.add(userId);
    // 添加种子用户
    ["alice", "bob", "charlie", "diana", "eve"].forEach(u => userSet.add(u));
    return Array.from(userSet).filter(u => u !== userId).sort();
  }, [conversations, userId]);

  // 群组列表
  const groupConversations = useMemo(() => {
    return conversations.filter(c => c.type === "group");
  }, [conversations]);

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

        {/* ─── 侧栏 Tab 切换 ─── */}
        <div className="im-sidebar-tabs">
          <button
            className={`im-sidebar-tab${sidebarTab === "chats" ? " active" : ""}`}
            onClick={() => setSidebarTab("chats")}
          >
            💬 消息
          </button>
          <button
            className={`im-sidebar-tab${sidebarTab === "contacts" ? " active" : ""}`}
            onClick={() => setSidebarTab("contacts")}
          >
            👤 通讯录
          </button>
          <button
            className={`im-sidebar-tab${sidebarTab === "groups" ? " active" : ""}`}
            onClick={() => setSidebarTab("groups")}
          >
            👥 群组
          </button>
        </div>

        <div className="im-search">
          <SearchIcon />
          <input
            placeholder={sidebarTab === "chats" ? "搜索消息..." : sidebarTab === "contacts" ? "搜索联系人..." : "搜索群组..."}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>

        <div className="im-connection-status" data-connected={wsConnected}>
          {wsConnected ? "已连接" : "未连接"}
        </div>

        {/* ─── 消息 Tab ─── */}
        {sidebarTab === "chats" && (
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
        )}

        {/* ─── 通讯录 Tab ─── */}
        {sidebarTab === "contacts" && (
        <div className="im-contacts-list">
          {knownUsers.length === 0 ? (
            <div className="im-empty-hint">
              <p>暂无联系人</p>
              <p style={{ fontSize: 11, color: "var(--fg-dim)" }}>通过群组会话添加联系人</p>
            </div>
          ) : (
            knownUsers.map((contactId) => (
              <div
                key={contactId}
                className="im-contact-row"
                onClick={async () => {
                  // 创建或打开与该用户的 DM
                  try {
                    const res = await fetch(apiPath("/api/im/conversations/dm"), {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ userId, targetId: contactId }),
                    });
                    const json = await res.json() as { ok: boolean; data: { id: string } };
                    if (json.ok) {
                      setActiveConversation(json.data.id);
                      setSidebarTab("chats");
                    }
                  } catch (e) {
                    console.error("[Inbox] create DM failed:", e);
                  }
                }}
              >
                <div className="im-avatar" style={{ background: avatarColor(contactId), width: 36, height: 36, fontSize: 16 }}>
                  {avatarInitial(contactId)}
                </div>
                <div className="im-contact-info">
                  <div className="im-contact-name">{contactId}</div>
                  <div className="im-contact-status">在线</div>
                </div>
              </div>
            ))
          )}
        </div>
        )}

        {/* ─── 群组 Tab ─── */}
        {sidebarTab === "groups" && (
        <div className="im-groups-list">
          <button
            className="im-new-group-btn"
            onClick={() => setNewConvOpen(true)}
          >
            + 创建群组
          </button>
          {groupConversations.length === 0 ? (
            <div className="im-empty-hint">
              <p>暂无群组</p>
            </div>
          ) : (
            groupConversations.map((conv) => (
              <div
                key={conv.id}
                className={`im-group-row${conv.id === activeConversationId ? " active" : ""}`}
                onClick={() => { setActiveConversation(conv.id); setSidebarTab("chats"); }}
              >
                <div className="im-group-icon">👥</div>
                <div className="im-group-info">
                  <div className="im-group-name">{conv.title || "未命名群组"}</div>
                  <div className="im-group-members">{conv.memberCount} 成员</div>
                </div>
                {unreadCounts.get(conv.id) ? (
                  <span className="im-group-unread">{unreadCounts.get(conv.id)}</span>
                ) : null}
              </div>
            ))
          )}
        </div>
        )}
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
                const prevMsg = globalIdx > 0 ? messages[globalIdx - 1] : null;
                const showSenderInfo = !prevMsg || prevMsg.senderId !== msg.senderId
                  || (msg.createdAt - prevMsg.createdAt > 60000);
                return (
                  <div key={msg.id}>
                    {showDateSep && <DateSeparator timestamp={msg.createdAt} />}
                    <MessageBubble
                      msg={msg}
                      isOwn={msg.senderId === userId}
                      showSender={showSenderInfo}
                      isGroupChat={isGroupChat}
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

/** 用户头像颜色池 */
const AVATAR_COLORS = ["#4A90D9", "#E74C3C", "#2ECC71", "#F39C12", "#9B59B6", "#1ABC9C", "#E67E22", "#3498DB"];
function avatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function avatarInitial(id: string) {
  return id.charAt(0).toUpperCase();
}

function MessageBubble({ msg, isOwn, showSender, isGroupChat: _isGroupChat, isEditing, editContent, onEditContentChange, onStartEdit, onCancelEdit, onConfirmEdit, onDelete, onReaction, onRemoveReaction, highlighted }: {
  msg: ImMessage;
  isOwn: boolean;
  showSender: boolean;
  isGroupChat: boolean;
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
      className={`im-msg-row${isOwn ? " own" : ""}${highlighted ? " highlighted" : ""}`}
      data-msg-id={msg.id}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onContextMenu={handleContextMenu}
    >
      {/* 头像区 */}
      {!isOwn && (
        <div className="im-avatar-col">
          {showSender && (
            <div className="im-avatar" style={{ background: avatarColor(msg.senderId) }}>
              {avatarInitial(msg.senderId)}
            </div>
          )}
        </div>
      )}

      {/* 消息内容区 */}
      <div className="im-msg-body">
        {showSender && !isOwn && (
          <div className="im-msg-sender" style={{ color: avatarColor(msg.senderId) }}>
            {msg.senderId}
            <span className="im-msg-time">{formatTime(msg.createdAt)}</span>
          </div>
        )}
        {showSender && isOwn && (
          <div className="im-msg-time-own">{formatTime(msg.createdAt)}</div>
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
              <MessageContent content={msg.content} />
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

      {/* 飞书风格浮动操作栏 */}
      {showActions && !isEditing && (
        <div className={`im-action-bar${isOwn ? " own" : ""}`}>
          <button className="im-action-btn" onClick={() => onReaction("👍")} title="点赞">👍</button>
          <button className="im-action-btn" onClick={() => onReaction("❤️")} title="爱心">❤️</button>
          <button className="im-action-btn" onClick={() => onReaction("😂")} title="笑哭">😂</button>
          <div className="im-action-divider" />
          <button className="im-action-btn" onClick={handleCopy} title="复制">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
          {isOwn && (
            <>
              <button className="im-action-btn" onClick={onStartEdit} title="编辑">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button className="im-action-btn im-action-danger" onClick={onDelete} title="撤回">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
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
        {msg.replyGroupId && <span title="气泡组"> 🔗</span>}
        {msg.sidechainId && <span title="侧链"> 🔀</span>}
      </div>
      </div>{/* end im-msg-body */}
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

// ─── 消息内容渲染器（@提及 + 链接 + 代码块） ──────────────

// URL 域名提取（暂未使用）
// function urlDomain(url: string): string {
//   try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
// }

/** 消息内容解析：@提及高亮 + URL 链接 + 行内代码 */
function MessageContent({ content }: { content: string }) {
  // 检测是否含代码块
  const hasCodeBlock = /```[\s\S]*?```/.test(content);

  if (hasCodeBlock) {
    // 代码块 + 普通文本混合渲染
    const parts = content.split(/(```[\s\S]*?```)/g);
    return (
      <div className="im-msg-content">
        {parts.map((part, i) => {
          if (part.startsWith("```") && part.endsWith("```")) {
            const inner = part.slice(3, -3);
            const firstLine = inner.indexOf("\n");
            const lang = firstLine > 0 ? inner.slice(0, firstLine).trim() : "";
            const code = firstLine > 0 ? inner.slice(firstLine + 1) : inner;
            return (
              <pre key={i} className="im-code-block">
                {lang && <div className="im-code-lang">{lang}</div>}
                <code>{code}</code>
              </pre>
            );
          }
          return <InlineContent key={i} text={part} />;
        })}
      </div>
    );
  }

  return (
    <div className="im-msg-content">
      <InlineContent text={content} />
    </div>
  );
}

/** 行内内容：@提及 + URL + 行内代码 */
function InlineContent({ text }: { text: string }) {
  // 匹配 @用户名、URL、`行内代码`
  const regex = /(@\w+)|(https?:\/\/[^\s<]+)|(`[^`]+`)/g;
  const parts: Array<{ type: "text" | "mention" | "url" | "code"; value: string }> = [];
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push({ type: "text", value: text.slice(lastIdx, match.index) });
    }
    if (match[1]) parts.push({ type: "mention", value: match[1] });
    else if (match[2]) parts.push({ type: "url", value: match[2] });
    else if (match[3]) parts.push({ type: "code", value: match[3] });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({ type: "text", value: text.slice(lastIdx) });
  }

  return (
    <>
      {parts.map((part, i) => {
        switch (part.type) {
          case "mention":
            return (
              <span key={i} className="im-mention">
                {part.value}
              </span>
            );
          case "url":
            return (
              <a key={i} className="im-link" href={part.value} target="_blank" rel="noopener noreferrer">
                {part.value}
              </a>
            );
          case "code":
            return (
              <code key={i} className="im-inline-code">
                {part.value.slice(1, -1)}
              </code>
            );
          default:
            return <span key={i} className="im-bubble-text">{part.value}</span>;
        }
      })}
    </>
  );
}
