/**
 * Termany IM Inbox — Feishu-inspired custom implementation
 *
 * Pure React + CSS (no third-party chat library).
 * Structured for pixel-level control over the Feishu-like aesthetic.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useImStore } from "../imStore";
import { useImWebSocket } from "../useImWebSocket";
import { imApi, type ImContact, type ImMember, type ImMessage, type ImCapabilities } from "../imClient";
import { ImMembersPanel } from "./ImMembersPanel";
import { useStore } from "../state/store";
import { useImeGuard } from "../imeGuard";
import { uuid } from "../uuid";
import { AgentTaskPanel } from "./AgentTaskPanel";
import type { ImAttachment } from "@termany/core";
import { ImHandoffPanel } from "./ImHandoffPanel";

// ─── 工具函数 ─────────────────────────────────────────

const AVATAR_COLORS = ["#3370ff", "#f54a45", "#34c724", "#ff9d00", "#a855f7", "#00b3c6", "#f97316", "#6366f1"];

function hashColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fmtDateSep(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - target.getTime()) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff}天前`;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function fmtConvTime(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - target.getTime()) / 86400000);
  if (diff === 0) return fmtTime(ts);
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff}天前`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// ─── 渲染消息内容（@提及 + 链接 + 代码） ────────────────

function renderContent(text: string) {
  const parts: React.ReactNode[] = [];
  const regex = /(@\w+)|(```(\w*)\n?([\s\S]*?)```)|(https?:\/\/[^\s<]+)|(`[^`]+`)/g;
  let lastIdx = 0;
  let m;
  let key = 0;

  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(<span key={key++}>{text.slice(lastIdx, m.index)}</span>);
    if (m[1]) {
      parts.push(<span key={key++} className="im-mention">{m[1]}</span>);
    } else if (m[2]) {
      parts.push(
        <pre key={key++} className="im-codeblock">
          {m[3] && <span className="im-codeblock-lang">{m[3]}</span>}
          <code>{m[4]}</code>
        </pre>
      );
    } else if (m[5]) {
      parts.push(<a key={key++} className="im-link" href={m[5]} target="_blank" rel="noopener noreferrer">{m[5]}</a>);
    } else if (m[6]) {
      parts.push(<code key={key++} className="im-inlinecode">{m[6].slice(1, -1)}</code>);
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(<span key={key++}>{text.slice(lastIdx)}</span>);
  return <>{parts}</>;
}

// ─── 头像组件 ────────────────────────────────────────────

function Av({ id, size = 36 }: { id: string; size?: number }) {
  return (
    <div className="im-av" style={{ width: size, height: size, background: hashColor(id), fontSize: size * 0.4 }}>
      {id.charAt(0).toUpperCase()}
    </div>
  );
}

// ─── 主组件 ──────────────────────────────────────────────

interface InboxProps { serverPort?: number; }

export function InboxV2({ serverPort = 5175 }: InboxProps) {
  const store = useImStore();
  const {
    conversations, activeConversationId, messages,
    unreadCounts, typingUsers, wsConnected, conversationsLoading, messagesLoading,
    userId,
    loadConversations, setActiveConversation, loadMoreMessages,
    sendMessage, deleteMessage, addReaction, removeReaction, setUserId,
  } = store;

  const { subscribe, unsubscribe, sendTyping } = useImWebSocket(serverPort);

  // 同步 userId
  const profile = useStore(s => s.userProfile);
  useEffect(() => {
    // Preserve an existing nickname-based identity once, then keep it stable.
    const id = profile.imUserId || profile.nickname?.trim() || "default-user";
    if (!profile.imUserId) useStore.getState().setUserProfile({ imUserId: id });
    setUserId(id);
  }, [profile.imUserId, profile.nickname, setUserId]);

  // 初始加载
  useEffect(() => { void loadConversations(); void store.loadUnreadCounts(); }, [userId, loadConversations]);

  // 侧栏 tab
  const [tab, setTab] = useState<"chats" | "contacts" | "groups">("chats");

  // 输入
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ImAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const attachmentDrafts = useRef(new Map<string, ImAttachment[]>());
  const ime = useImeGuard();
  const [directory, setDirectory] = useState<ImContact[]>([]);
  const [members, setMembers] = useState<ImMember[]>([]);
  const [capabilities, setCapabilities] = useState<ImCapabilities>();
  const [showMembers, setShowMembers] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const requestRef = useRef<{ key: string; id: string }>();
  const [reply, setReply] = useState<ImMessage | null>(null);
  const [editing, setEditing] = useState<ImMessage | null>(null);
  const [editText, setEditText] = useState("");
  const [showGroup, setShowGroup] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const drafts = useRef(new Map<string, string>());
  const previousConversation = useRef<string | null>(null);
  const displayName = (id: string) => directory.find(contact => contact.id === id)?.name || id;
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const run = async (action: () => Promise<unknown>) => { setError(""); try { await action(); } catch (reason) { report(reason); } };
  useEffect(() => {
    let active = true;
    imApi.listContacts().then(contacts => { if (active) setDirectory(contacts); }).catch(report);
    imApi.capabilities().then(data => { if (active) setCapabilities(data); }).catch(() => { if (active) setCapabilities(undefined); });
    return () => { active = false; };
  }, [userId, conversations.length]);
  useEffect(() => {
    let active = true;
    setMembers([]);
    if (activeConversationId) imApi.listMembers(activeConversationId, userId)
      .then(data => { if (active) setMembers(data); }).catch(report);
    return () => { active = false; };
  }, [activeConversationId, userId]);
  useEffect(() => {
    if (previousConversation.current) drafts.current.set(previousConversation.current, draft);
    if (previousConversation.current) attachmentDrafts.current.set(previousConversation.current, attachments);
    setDraft(activeConversationId ? drafts.current.get(activeConversationId) || "" : "");
    setAttachments(activeConversationId ? attachmentDrafts.current.get(activeConversationId) || [] : []);
    previousConversation.current = activeConversationId;
    setReply(null); setEditing(null); setShowMentions(false);
  }, [activeConversationId]);

  // 派生数据
  const activeConv = conversations.find(c => c.id === activeConversationId);
  const isGroup = activeConv?.type === "group";
  const groups = conversations.filter(c => c.type === "group");
  const contacts = directory.filter(contact => contact.id !== userId && `${contact.name} ${contact.id}`.toLowerCase().includes(filter.toLowerCase()));
  const filteredConversations = conversations.filter(conv => `${conv.title} ${conv.preview}`.toLowerCase().includes(filter.toLowerCase()));
  const totalUnread = useMemo(() => {
    let n = 0; unreadCounts.forEach(v => n += v); return n;
  }, [unreadCounts]);

  // 消息按日期分组
  const msgSections = useMemo(() => {
    const sections: Array<{ date: string; msgs: ImMessage[] }> = [];
    let curDate = "";
    for (const msg of messages) {
      const d = fmtDateSep(msg.createdAt);
      if (d !== curDate) { sections.push({ date: d, msgs: [msg] }); curDate = d; }
      else sections[sections.length - 1].msgs.push(msg);
    }
    return sections;
  }, [messages]);

  // 订阅频道
  useEffect(() => {
    conversations.forEach(c => subscribe(`conversation:${c.id}`));
    return () => conversations.forEach(c => unsubscribe(`conversation:${c.id}`));
  }, [conversations, subscribe, unsubscribe]);

  // 切换会话加载消息


  // 自动滚动
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages.length]);

  // 发送
  const handleSend = async () => {
    const content = draft.trim();
    if ((!content && !attachments.length) || !activeConversationId || sendingRef.current || uploading) return;
    const conversationId = activeConversationId;
    const key = JSON.stringify([conversationId, content, reply?.seq, attachments.map(file => file.id)]);
    if (requestRef.current?.key !== key) requestRef.current = { key, id: uuid() };
    sendingRef.current = true; setSending(true); setError("");
    try {
      await sendMessage(content, { replyToSeq: reply?.seq, clientRequestId: requestRef.current.id, attachmentIds: attachments.map(file => file.id) });
      drafts.current.delete(conversationId);
      attachmentDrafts.current.delete(conversationId);
      if (useImStore.getState().activeConversationId === conversationId) { setDraft(""); setAttachments([]); setReply(null); }
      requestRef.current = undefined;
    } catch (reason) { report(reason); }
    finally { sendingRef.current = false; setSending(false); }
  };

  const handleInput = (value: string) => {
    setDraft(value);
    if (activeConversationId) { drafts.current.set(activeConversationId, value); sendTyping(`conversation:${activeConversationId}`); }
  };

  const uploadAttachments = async (files: FileList | null) => {
    if (!files?.length || !activeConversationId || uploading) return;
    const conversationId = activeConversationId;
    if (files.length + attachments.length > 8) { setError("每条消息最多 8 个附件"); return; }
    setUploading(true); setError("");
    try {
      for (const file of Array.from(files)) {
        const uploaded = await imApi.uploadAttachment(conversationId, userId, file);
        const existing = attachmentDrafts.current.get(conversationId) || attachments;
        const next = [...existing, uploaded];
        attachmentDrafts.current.set(conversationId, next);
        if (useImStore.getState().activeConversationId === conversationId) setAttachments(next);
      }
    } catch (reason) { report(reason); }
    finally { setUploading(false); if (attachmentInput.current) attachmentInput.current.value = ""; }
  };

  const openDM = async (contact: ImContact) => run(async () => {
    const conversation = await imApi.createDm(userId, contact.id, contact.type);
    await loadConversations();
    setActiveConversation(conversation.id); setTab("chats"); setFilter("");
  });

  const createGroup = async () => run(async () => {
    const conversation = await imApi.createGroup(groupTitle.trim(), userId,
      selectedMembers.map(id => ({ id, type: directory.find(contact => contact.id === id)?.type || "user" })));
    await loadConversations();
    setActiveConversation(conversation.id); setTab("chats"); setShowGroup(false); setGroupTitle(""); setSelectedMembers([]); setFilter("");
  });

  const jumpToMessage = async (conversationId: string, seq: number) => run(async () => {
    setActiveConversation(conversationId); setTab("chats");
    await useImStore.getState().loadMessages(conversationId);
    while (useImStore.getState().activeConversationId === conversationId && useImStore.getState().messagesHasMore &&
      (useImStore.getState().messages[0]?.seq ?? Infinity) > seq) {
      const before = useImStore.getState().messagesNextCursor;
      await useImStore.getState().loadMoreMessages();
      if (before === useImStore.getState().messagesNextCursor) break;
    }
    requestAnimationFrame(() => document.getElementById(`im-message-${seq}`)?.scrollIntoView({ block: "center" }));
  });

  return (
    <div className="im-root">
      {/* ═══ 侧栏 ═══ */}
      <aside className="im-side">
        <div className="im-side-head">
          <span className="im-side-title">消息</span>
          <span className="im-chat-sub" role="status">{wsConnected ? "已连接" : "连接中"}</span>
          <button className="im-tool-btn" onClick={() => setShowGroup(!showGroup)}>建群</button>
          {totalUnread > 0 && <span className="im-side-badge">{totalUnread > 99 ? "99+" : totalUnread}</span>}
        </div>

        {/* Tab */}
        <nav className="im-tabs">
          {(["chats", "contacts", "groups"] as const).map(t => (
            <button key={t} className={`im-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
              {t === "chats" ? "消息" : t === "contacts" ? "通讯录" : "群组"}
            </button>
          ))}
        </nav>

        {/* 搜索 */}
        <div className="im-search-wrap">
          <svg className="im-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input className="im-search" aria-label="搜索会话或消息" placeholder="搜索会话；回车搜索消息" value={filter}
            onChange={event => { setFilter(event.target.value); if (!event.target.value) store.clearSearch(); }}
            onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void store.search(filter); }} />
        </div>

        {showGroup && <form className="im-create-group" onSubmit={event => { event.preventDefault(); void createGroup(); }}>
          <input aria-label="群名称" placeholder="群名称" value={groupTitle} onChange={event => setGroupTitle(event.target.value)} required />
          {directory.filter(contact => contact.id !== userId).map(contact => <label key={contact.id}>
            <input type="checkbox" checked={selectedMembers.includes(contact.id)} onChange={event => setSelectedMembers(ids => event.target.checked ? [...ids, contact.id] : ids.filter(id => id !== contact.id))} />
            {contact.name} {contact.type === "bot" ? "· 智能体" : ""}
          </label>)}
          <button type="submit" disabled={!groupTitle.trim() || !selectedMembers.length}>创建群聊</button>
        </form>}
        {store.searchQuery && <div className="im-search-results">
          <p>{store.searchLoading ? "搜索中…" : `${store.searchResults.length} 条消息`}</p>
          {store.searchResults.map(result => <button key={result.messageId} onClick={() => void jumpToMessage(result.conversationId, result.seq)}>{result.content.slice(0, 100)}</button>)}
        </div>}
        {/* 列表 */}
        <div className="im-list">
          {tab === "chats" && filteredConversations.map(conv => (
            <div
              key={conv.id}
              className={`im-conv${conv.id === activeConversationId ? " on" : ""}`}
              onClick={() => setActiveConversation(conv.id)}
            >
              <Av id={conv.type === "group" ? conv.title || "G" : conv.id} size={40} />
              <div className="im-conv-body">
                <div className="im-conv-row1">
                  <span className="im-conv-name">{conv.title || (conv.type === "group" ? "群组" : "私聊")}</span>
                  <span className="im-conv-time">{fmtConvTime(conv.updatedAt)}</span>
                </div>
                <div className="im-conv-row2">
                  <span className="im-conv-preview">{conv.preview || (conv.type === "group" ? `${conv.memberCount}人` : "")}</span>
                  {(unreadCounts.get(conv.id) ?? 0) > 0 && (
                    <span className="im-conv-unread">{unreadCounts.get(conv.id)}</span>
                  )}
                </div>
              </div>
            </div>
          ))}

          {tab === "contacts" && contacts.map(contact => (
            <div key={contact.id} className="im-conv" onClick={() => void openDM(contact)}>
              <Av id={contact.name} size={40} />
              <div className="im-conv-body">
                <div className="im-conv-row1">
                  <span className="im-conv-name">{contact.name}</span>
                </div>
                <div className="im-conv-row2">
                  <span className="im-conv-meta" title={capabilities?.agents.find(agent => agent.id === contact.id)?.reason}>{contact.type === "bot" ? (capabilities?.agents.find(agent => agent.id === contact.id)?.available ? "智能体 · 运行环境已就绪（连接以执行为准）" : capabilities ? "智能体 · 环境未就绪，请检查设置" : "智能体 · 环境状态待检测") : "用户"}</span>
                </div>
              </div>
            </div>
          ))}

          {tab === "groups" && groups.filter(conv => conv.title.toLowerCase().includes(filter.toLowerCase())).map(conv => (
            <div
              key={conv.id}
              className={`im-conv${conv.id === activeConversationId ? " on" : ""}`}
              onClick={() => { setActiveConversation(conv.id); setTab("chats"); }}
            >
              <Av id={conv.title || "G"} size={40} />
              <div className="im-conv-body">
                <div className="im-conv-row1">
                  <span className="im-conv-name">{conv.title || "未命名群组"}</span>
                </div>
                <div className="im-conv-row2">
                  <span className="im-conv-meta">{conv.memberCount} 成员</span>
                  {(unreadCounts.get(conv.id) ?? 0) > 0 && (
                    <span className="im-conv-unread">{unreadCounts.get(conv.id)}</span>
                  )}
                </div>
              </div>
            </div>
          ))}

          {conversationsLoading && <div className="im-empty">加载中...</div>}
          {!conversationsLoading && tab === "chats" && conversations.length === 0 && (
            <div className="im-empty">
              <p>暂无会话</p>
              <p className="im-empty-hint">从通讯录选择联系人开始对话</p>
            </div>
          )}
        </div>
      </aside>

      {/* ═══ 聊天区 ═══ */}
      <main className="im-chat">
        {error && <div role="alert" className="im-error">{error}<button onClick={() => setError("")}>关闭</button></div>}
        {activeConv ? (
          <>
            {/* 头部 */}
            <header className="im-chat-head">
              <div className="im-chat-head-left">
                <Av id={isGroup ? activeConv.title || "G" : activeConv.id} size={28} />
                <div>
                  <div className="im-chat-title">{activeConv.title || members.filter(member => member.userOrBotId !== userId).map(member => displayName(member.userOrBotId)).join("、") || "私聊"}</div>
                  <div className="im-chat-sub">{isGroup ? `${activeConv.memberCount} 成员` : "私聊"}</div>
                </div>
              </div>
              <div className="im-message-actions">
                {isGroup && <button onClick={() => setShowMembers(!showMembers)}>群成员</button>}
                <button onClick={() => setShowHandoff(!showHandoff)}>智能体接力</button>
                <button onClick={() => void run(() => store.pinConversation(activeConv.id, true))}>置顶会话</button>
                <button onClick={() => void run(() => store.pinConversation(activeConv.id, false))}>取消置顶</button>
                <button onClick={() => void run(() => store.muteConversation(activeConv.id, true))}>静音</button>
                <button onClick={() => void run(() => store.muteConversation(activeConv.id, false))}>取消静音</button>
              </div>
            </header>
            {isGroup && showMembers && <ImMembersPanel key={activeConv.id} conversationId={activeConv.id} userId={userId} members={members} contacts={directory} updated={async data => { setMembers(data); await loadConversations(); }} />}

            {showHandoff && <ImHandoffPanel key={activeConv.id} conversationId={activeConv.id} userId={userId} members={members} contacts={directory} openConversation={async id => {
              await loadConversations(); setActiveConversation(id); setShowHandoff(false);
            }} />}

            {members.some(member => member.memberType === "bot") && <AgentTaskPanel key={activeConv.id} conversationId={activeConv.id} userId={userId} members={members} contacts={directory} />}

            {/* 消息列表 */}
            <div className="im-msgs" ref={scrollRef}>
              {store.messagesHasMore && <button className="im-history" disabled={messagesLoading} onClick={() => void loadMoreMessages()}>加载更早消息</button>}
              {messagesLoading && <p role="status">加载消息…</p>}
              {msgSections.map((sec, si) => (
                <div key={si}>
                  <div className="im-date-sep"><span>{sec.date}</span></div>
                  {sec.msgs.map((msg, mi) => {
                    if (msg.isDeleted) {
                      return <div key={msg.id} className="im-msg-deleted">消息已撤回</div>;
                    }
                    const own = msg.senderId === userId;
                    const prevMsg = mi > 0 ? sec.msgs[mi - 1] : (si > 0 ? msgSections[si - 1].msgs.at(-1) : null);
                    const showAv = !prevMsg || prevMsg.senderId !== msg.senderId || (msg.createdAt - prevMsg.createdAt > 60000);

                    return (
                      <div id={`im-message-${msg.seq}`} key={msg.id} className={`im-msg-wrap${own ? " own" : ""}${showAv ? " gap" : ""}`}>
                        {showAv && !own && <Av id={msg.senderId} size={36} />}
                        {showAv && own && <div className="im-av-spacer" />}
                        <div className={`im-msg-col${own ? " own" : ""}`}>
                          {showAv && (
                            <div className={`im-msg-meta${own ? " own" : ""}`}>
                              {!own && <span className="im-msg-sender" style={{ color: hashColor(msg.senderId) }}>{displayName(msg.senderId)}</span>}
                              <span className="im-msg-ts">{fmtTime(msg.createdAt)}</span>
                            </div>
                          )}
                          <div className={`im-bubble${own ? " own" : ""}`}>
                            {msg.replyToSeq && <div className="im-reply-preview">引用消息 #{msg.replyToSeq}</div>}
                            {editing?.id === msg.id ? <div>
                              <textarea aria-label="编辑消息" value={editText} onChange={event => setEditText(event.target.value)} />
                              <button onClick={() => void run(async () => { await store.editMessage(msg.id, editText); setEditing(null); })}>保存</button>
                              <button onClick={() => setEditing(null)}>取消</button>
                            </div> : renderContent(msg.content)}
                            {msg.metadata.attachments?.map(file => <div className="im-attachment" key={file.id}>
                              {file.mimeType.startsWith("image/") && <a href={imApi.attachmentUrl(file.id, userId, true)} target="_blank" rel="noreferrer"><img alt={file.name} loading="lazy" src={imApi.attachmentUrl(file.id, userId, true)} /></a>}
                              <a href={imApi.attachmentUrl(file.id, userId)} download={file.name}>{file.name} · {Math.ceil(file.size / 1024)} KB</a>
                            </div>)}
                          </div>
                          <div className="im-message-actions">
                            <button onClick={() => setReply(msg)}>引用</button>
                            <button onClick={() => void run(() => addReaction(msg.id, "👍"))}>👍</button>
                            <button onClick={() => void run(async () => { await imApi.pinMessage(msg.id, !msg.isPinned, store.userId); store.updateMessage(msg.id, { isPinned: !msg.isPinned }); })}>{msg.isPinned ? "取消置顶" : "置顶"}</button>
                            {own && <><button onClick={() => { setEditing(msg); setEditText(msg.content); }}>编辑</button>
                            <button onClick={() => void run(() => deleteMessage(msg.id))}>撤回</button></>}
                          </div>
                          {msg.reactions && msg.reactions.length > 0 && (
                            <div className="im-reacts">
                              {Array.from(new Set(msg.reactions.map(r => r.emoji))).map(emoji => {
                                const count = msg.reactions!.filter(r => r.emoji === emoji).length;
                                const mine = msg.reactions!.some(r => r.emoji === emoji && r.userOrBotId === userId);
                                return (
                                  <button
                                    key={emoji}
                                    className={`im-react-chip${mine ? " mine" : ""}`}
                                    onClick={() => void run(() => mine ? removeReaction(msg.id, emoji) : addReaction(msg.id, emoji))}
                                  >
                                    {emoji} {count}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}

              {typingUsers.size > 0 && (
                <div className="im-typing">
                  <span className="im-typing-dots"><i /><i /><i /></span>
                  {Array.from(typingUsers.keys()).filter(id => id !== userId).map(displayName).join(", ")} 正在输入...
                </div>
              )}
            </div>

            {/* 输入区 */}
            <footer className="im-input-area">
              {!!attachments.length && <div className="im-picker">{attachments.map(file => <span key={file.id}>{file.name}<button aria-label={`移除 ${file.name}`} onClick={() => {
                const next = attachments.filter(item => item.id !== file.id); setAttachments(next);
                if (activeConversationId) attachmentDrafts.current.set(activeConversationId, next);
              }}>×</button></span>)}</div>}
              <input ref={attachmentInput} hidden type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx" onChange={event => void uploadAttachments(event.target.files)} />
              {reply && <div className="im-reply-preview">引用：{reply.content.slice(0, 100)}<button onClick={() => setReply(null)}>取消</button></div>}
              {showMentions && <div className="im-picker">{members.filter(member => member.userOrBotId !== userId).map(member => <button key={member.userOrBotId}
                onClick={() => { handleInput(`${draft}@${displayName(member.userOrBotId)} `); setShowMentions(false); }}>{displayName(member.userOrBotId)}</button>)}</div>}
              {showEmoji && <div className="im-picker">{["😊", "👍", "🎉", "❤️", "✅"].map(emoji => <button key={emoji} onClick={() => { handleInput(draft + emoji); setShowEmoji(false); }}>{emoji}</button>)}</div>}
              <div className="im-input-toolbar">
                <button className="im-tool-btn" title="@提及" onClick={() => setShowMentions(!showMentions)}>@</button>
                <button className="im-tool-btn" title="表情" onClick={() => setShowEmoji(!showEmoji)}>😊</button>
                <button className="im-tool-btn" title="上传附件（每个最多 10 MB）" disabled={uploading || sending} onClick={() => attachmentInput.current?.click()}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.85l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
              </div>
              <textarea
                {...ime.props}
                aria-label="消息内容"
                className="im-input"
                placeholder="输入消息... (Enter 发送)"
                value={draft}
                onChange={e => handleInput(e.target.value)}
                onKeyDown={e => {
                  if (!ime.handled(e) && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
                }}
                rows={3}
              />
              <div className="im-input-foot">
                <span className="im-input-hint">Enter 发送 · Shift+Enter 换行</span>
                <button className="im-send-btn" onClick={() => void handleSend()} disabled={(!draft.trim() && !attachments.length) || sending || uploading}>{uploading ? "上传中…" : sending ? "发送中…" : "发送"}</button>
              </div>
            </footer>
          </>
        ) : (
          <div className="im-no-chat">
            <div className="im-no-chat-icon">💬</div>
            <h3>选择一个会话开始聊天</h3>
            <p>从左侧列表选择会话，或从通讯录创建新对话</p>
          </div>
        )}
      </main>
    </div>
  );
}
