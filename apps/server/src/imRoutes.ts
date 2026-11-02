import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ImService } from "./imService.js";
import type { HandoffService, HandoffSnapshot } from "./imHandoff.js";
import { splitIntoBubbles } from "./imBubbleSplit.js";
import type { ImTaskService, ImExecutionSettings } from "./imTasks.js";
import { IM_ATTACHMENT_LIMIT, type ImAttachmentService } from "./imAttachments.js";

export function createImHttpHandler(deps: {
  imService: ImService;
  handoffService: HandoffService;
  readJson: (req: IncomingMessage) => Promise<any>;
  agents?: () => Array<{ id: string; name: string; enabled: boolean }>;
  tasks?: ImTaskService;
  attachments?: ImAttachmentService;
  respondPermission?: (paneId: string, requestId: string, optionId: string) => boolean;
  capabilities?: () => Promise<{ llmConfigured: boolean; agents: Array<{ id: string; available: boolean; reason?: string }> }>;
}) {
  const { imService, handoffService, readJson } = deps;
  const previews = new Map<string, { snapshot: HandoffSnapshot; userId: string; expires: number }>();
  return (req: IncomingMessage, res: ServerResponse) => {
  const reqUrl = new URL(req.url ?? "/", "http://localhost");
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not a member|not the sender|only.*sender|permission|forbidden/i.test(message) ? 403
      : /not found/i.test(message) ? 404 : 400;
    json(status, { ok: false, error: message });
  };
  const requireMember = (conversationId: string, userId: string) => {
    if (!imService.getConversation(conversationId)) throw new Error("conversation not found");
    if (!imService.isMember(conversationId, userId)) throw new Error("not a member");
  };
  const conversationRead = reqUrl.pathname.match(/^\/api\/im\/conversations\/([^/]+)(?:\/.*)?$/);
  if (req.method === "GET" && conversationRead) {
    try { requireMember(conversationRead[1], reqUrl.searchParams.get("user_id") || "default-user"); }
    catch (error) { fail(error); return; }
  }
  // ─── IM 消息系统 API ────────────────────────────────────

  if (req.method === "GET" && reqUrl.pathname === "/api/im/capabilities") {
    void (deps.capabilities?.() || Promise.resolve({ llmConfigured: false, agents: [] }))
      .then(data => json(200, { ok: true, data })).catch(fail);
    return;
  }

  const memberMutation = reqUrl.pathname.match(/^\/api\/im\/conversations\/([^/]+)\/members$/);
  if (memberMutation && (req.method === "POST" || req.method === "DELETE")) {
    readJson(req).then(body => {
      const id = memberMutation[1];
      const actor = String(body?.userId || "default-user");
      requireMember(id, actor);
      if (imService.getConversation(id)?.type !== "group") throw new Error("only groups support member management");
      const members = imService.listMembers(id);
      if (!members.some(member => member.userOrBotId === actor && ["owner", "admin"].includes(member.role))) throw new Error("permission denied");
      if (deps.tasks?.list(id).some(task => ["queued", "running"].includes(task.status))) throw new Error("finish or cancel active tasks before changing members");
      const targetId = String(body?.targetId || "").trim();
      if (!targetId) throw new Error("member ID is required");
      if (req.method === "DELETE") {
        const target = members.find(member => member.userOrBotId === targetId);
        if (!target) throw new Error("member not found");
        if (target.role === "owner") throw new Error("permission denied: owner cannot be removed");
        if (target.role === "admin" && !members.some(member => member.userOrBotId === actor && member.role === "owner")) throw new Error("permission denied: only owner can remove administrators");
        if (deps.tasks?.settings(id).leadAgentId === targetId) throw new Error("choose another lead agent before removing this member");
        imService.removeMember(id, targetId);
      } else {
        const contact = [...imService.listContacts(), ...(deps.agents?.() || []).filter(agent => agent.enabled).map(agent => ({ id: agent.id, type: "bot" as const }))].find(contact => contact.id === targetId);
        if (!contact) throw new Error("contact not found");
        imService.addMember(id, targetId, contact.type);
      }
      json(200, { ok: true, data: imService.listMembers(id) });
    }).catch(fail);
    return;
  }

  const uploadRoute = reqUrl.pathname.match(/^\/api\/im\/conversations\/([^/]+)\/attachments$/);
  if (req.method === "POST" && uploadRoute && deps.attachments) {
    void (async () => {
      const userId = reqUrl.searchParams.get("user_id") || "default-user";
      deps.attachments!.authorize(uploadRoute[1], userId);
      if (Number(req.headers["content-length"]) > IM_ATTACHMENT_LIMIT) {
        req.resume(); json(413, { ok: false, error: "attachment maximum is 10 MB" }); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size <= IM_ATTACHMENT_LIMIT) chunks.push(Buffer.from(chunk));
      }
      if (size > IM_ATTACHMENT_LIMIT) { json(413, { ok: false, error: "attachment maximum is 10 MB" }); return; }
      const file = await deps.attachments!.upload(uploadRoute[1], userId,
        decodeURIComponent(String(req.headers["x-file-name"] || "")), Buffer.concat(chunks));
      json(200, { ok: true, data: file });
    })().catch(fail);
    return;
  }
  const downloadRoute = reqUrl.pathname.match(/^\/api\/im\/attachments\/([a-f0-9-]+)(\/preview)?$/i);
  if (req.method === "GET" && downloadRoute && deps.attachments) {
    void (async () => {
      const file = deps.attachments!.get(downloadRoute[1], reqUrl.searchParams.get("user_id") || "default-user");
      const preview = Boolean(downloadRoute[2]);
      if (preview && !file.mimeType.startsWith("image/")) throw new Error("inline preview supports images only");
      const contents = await deps.attachments!.read(file);
      res.writeHead(200, { "Content-Type": preview ? file.mimeType : "application/octet-stream",
        "Content-Length": contents.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}` });
      res.end(contents);
    })().catch(fail);
    return;
  }

  const taskRoute = reqUrl.pathname.match(/^\/api\/im\/tasks\/([^/]+)\/(cancel|retry|permission)$/);
  if (req.method === "POST" && taskRoute && deps.tasks) {
    readJson(req).then(body => {
      try {
        const task = deps.tasks!.get(taskRoute[1]);
        if (!task) throw new Error("task not found");
        if (!imService.isMember(task.conversationId, String(body?.userId || "default-user"))) throw new Error("not a member");
        const result = taskRoute[2] === "permission"
          ? deps.tasks!.respondPermission(task.id, String(body?.requestId), String(body?.optionId), deps.respondPermission || (() => false))
          : taskRoute[2] === "retry" ? deps.tasks!.retry(task.id) : deps.tasks!.cancel(task.id);
        json(200, { ok: true, data: result });
      } catch (error) { fail(error); }
    }).catch(fail);
    return;
  }
  const executionRoute = reqUrl.pathname.match(/^\/api\/im\/conversations\/([^/]+)\/(tasks|execution-settings)$/);
  if (executionRoute && deps.tasks) {
    const id = executionRoute[1];
    if (req.method === "GET") {
      if (!imService.isMember(id, reqUrl.searchParams.get("user_id") || "default-user")) { json(403, { ok: false, error: "not a member" }); return; }
      json(200, { ok: true, data: executionRoute[2] === "tasks" ? deps.tasks.list(id) : deps.tasks.settings(id) });
      return;
    }
    if (req.method === "PUT" && executionRoute[2] === "execution-settings") {
      readJson(req).then(body => {
        try {
          const userId = String(body?.userId || "default-user");
          if (!imService.listMembers(id).some(member => member.userOrBotId === userId && ["owner", "admin"].includes(member.role))) throw new Error("permission denied");
          deps.tasks!.configure(id, body.settings as ImExecutionSettings);
          json(200, { ok: true, data: deps.tasks!.settings(id) });
        } catch (error) { fail(error); }
      }).catch(fail);
      return;
    }
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/im/contacts") {
    const contacts = new Map(imService.listContacts().map(contact => [contact.id, contact]));
    for (const agent of deps.agents?.() ?? []) {
      if (agent.enabled) contacts.set(agent.id, { id: agent.id, name: agent.name, type: "bot" });
    }
    json(200, { ok: true, data: [...contacts.values()] });
    return;
  }

  if (req.method === "GET" && /^\/api\/im\/conversations\/[^/]+\/members$/.test(reqUrl.pathname)) {
    const id = reqUrl.pathname.split("/")[4];
    const userId = reqUrl.searchParams.get("user_id") || "default-user";
    if (!imService.isMember(id, userId)) { json(403, { ok: false, error: "not a member" }); return; }
    json(200, { ok: true, data: imService.listMembers(id) });
    return;
  }

  // 会话列表
  if (req.method === "GET" && reqUrl.pathname === "/api/im/conversations") {
    try {
      const userId = reqUrl.searchParams.get("user_id") || "default-user";
      const limit = Number(reqUrl.searchParams.get("limit") || "50");
      const conversations = imService.listConversations(userId, limit);
      const names = new Map((deps.agents?.() ?? []).map(agent => [agent.id, agent.name]));
      json(200, { ok: true, data: conversations.map(conversation => ({
        ...conversation,
        title: conversation.type === "dm" ? imService.listMembers(conversation.id)
          .filter(member => member.userOrBotId !== userId)
          .map(member => names.get(member.userOrBotId) || member.userOrBotId).join("、") : conversation.title,
      })) });
    } catch (e) { fail(e); }
    return;
  }

  // 创建 DM
  if (req.method === "POST" && reqUrl.pathname === "/api/im/conversations/dm") {
    readJson(req).then((body) => {
      try {
        const conv = imService.createDm({
          userId: String(body?.userId ?? "default-user"),
          targetId: String(body?.targetId ?? ""),
          targetType: body?.targetType === "bot" ? "bot" : "user",
        });
        json(200, { ok: true, data: conv });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 创建群组
  if (req.method === "POST" && reqUrl.pathname === "/api/im/conversations/group") {
    readJson(req).then((body) => {
      try {
        const conv = imService.createGroup({
          title: String(body?.title ?? ""),
          ownerId: String(body?.ownerId ?? "default-user"),
          members: Array.isArray(body?.members) ? body.members : [],
          clientRequestId: body?.clientRequestId,
          sidechainId: body?.sidechainId,
          replyGroupId: body?.replyGroupId,
        });
        json(200, { ok: true, data: conv });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 获取单个会话
  if (req.method === "GET" && reqUrl.pathname.startsWith("/api/im/conversations/") && reqUrl.pathname.split("/").length === 5) {
    try {
      const convId = reqUrl.pathname.split("/")[4];
      const conv = imService.getConversation(convId);
      if (!conv) { json(404, { error: "conversation not found" }); return; }
      json(200, { ok: true, data: conv });
    } catch (e) { fail(e); }
    return;
  }

  // 删除会话
  if (req.method === "DELETE" && reqUrl.pathname.startsWith("/api/im/conversations/") && reqUrl.pathname.split("/").length === 5) {
    readJson(req).then((body) => {
      try {
        const convId = reqUrl.pathname.split("/")[4];
        const userId = String(body?.userId ?? "default-user");
        
        // 权限检查：用户必须是会话成员
        const conv = imService.getConversation(convId);
        if (!conv) { json(404, { error: "conversation not found" }); return; }
        
        if (!imService.isMember(convId, userId)) {
          json(403, { error: "not a member of this conversation" });
          return;
        }
        
        const deleted = imService.deleteConversation(convId);
        json(200, { ok: true, data: { deleted } });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 获取消息历史（cursor 分页）
  if (req.method === "GET" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/messages$/)) {
    try {
      const parts = reqUrl.pathname.split("/");
      const convId = parts[4];
      const beforeSeq = reqUrl.searchParams.get("before_seq");
      const limit = Number(reqUrl.searchParams.get("limit") || "40");
      const userId = reqUrl.searchParams.get("user_id") || "default-user";

      const page = imService.getMessages(convId, {
        beforeSeq: beforeSeq ? Number(beforeSeq) : undefined,
        limit,
        userId,
      });
      json(200, { ok: true, data: page });
    } catch (e) { fail(e); }
    return;
  }

  // 发送消息
  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/messages$/)) {
    readJson(req).then((body) => {
      try {
        const parts = reqUrl.pathname.split("/");
        const convId = parts[4];
        const senderId = String(body?.senderId ?? "default-user");
        const metadata = { ...(body?.metadata ?? {}) };
        delete metadata.handoffSnapshotId;
        delete metadata.handoffExecution;
        if (body?.attachmentIds !== undefined) {
          if (!deps.attachments) throw new Error("attachments unavailable");
          metadata.attachments = deps.attachments.resolve(body.attachmentIds, convId, senderId);
        } else delete metadata.attachments;
        const msg = imService.sendMessage(convId, {
          senderId,
          senderType: body?.senderType === "agent" ? "agent" : "user",
          role: body?.role === "assistant" ? "assistant" : "user",
          content: String(body?.content ?? ""),
          messageType: body?.messageType ?? "text",
          metadata,
          replyToSeq: body?.replyToSeq ? Number(body.replyToSeq) : undefined,
          clientRequestId: body?.clientRequestId,
          sidechainId: body?.sidechainId,
          replyGroupId: body?.replyGroupId,
        });
        json(200, { ok: true, data: msg });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 编辑消息
  if (req.method === "PUT" && reqUrl.pathname.match(/^\/api\/im\/messages\/\d+$/)) {
    readJson(req).then((body) => {
      try {
        const msgId = Number(reqUrl.pathname.split("/")[4]);
        const senderId = String(body?.senderId ?? "default-user");
        const msg = imService.editMessage(msgId, senderId, String(body?.content ?? ""));
        json(200, { ok: true, data: msg });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 撤回消息
  if (req.method === "DELETE" && reqUrl.pathname.match(/^\/api\/im\/messages\/\d+$/)) {
    try {
      const msgId = Number(reqUrl.pathname.split("/")[4]);
      const senderId = reqUrl.searchParams.get("sender_id") || "default-user";
      imService.deleteMessage(msgId, senderId);
      json(200, { ok: true });
    } catch (e) { fail(e); }
    return;
  }

  // 标记已读
  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/read$/)) {
    readJson(req).then((body) => {
      try {
        const convId = reqUrl.pathname.split("/")[4];
        const userId = String(body?.userId ?? "default-user");
        const seq = Number(body?.seq ?? 0);
        requireMember(convId, userId);
        imService.markAsRead(convId, userId, seq);
        json(200, { ok: true });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 未读计数
  if (req.method === "GET" && reqUrl.pathname === "/api/im/unread-counts") {
    try {
      const userId = reqUrl.searchParams.get("user_id") || "default-user";
      const counts = imService.getUnreadCounts(userId);
      json(200, { ok: true, data: counts });
    } catch (e) { fail(e); }
    return;
  }

  // 搜索
  if (req.method === "GET" && reqUrl.pathname === "/api/im/search") {
    try {
      const query = reqUrl.searchParams.get("q") || "";
      const convId = reqUrl.searchParams.get("conversation_id") || undefined;
      const limit = Number(reqUrl.searchParams.get("limit") || "20");
      if (!query) { json(200, { ok: true, data: [] }); return; }
      const userId = reqUrl.searchParams.get("user_id") || "default-user";
      if (convId && !imService.isMember(convId, userId)) throw new Error("not a member");
      const results = imService.search(query, { conversationId: convId, limit, userId });
      json(200, { ok: true, data: results });
    } catch (e) { fail(e); }
    return;
  }

  // 置顶会话
  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/pin$/)) {
    readJson(req).then((body) => {
      try {
        const convId = reqUrl.pathname.split("/")[4];
        const userId = String(body?.userId ?? "default-user");
        const pinned = body?.pinned !== false;
        requireMember(convId, userId);
        imService.pinConversation(convId, userId, pinned);
        json(200, { ok: true });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 静音会话
  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/mute$/)) {
    readJson(req).then((body) => {
      try {
        const convId = reqUrl.pathname.split("/")[4];
        const userId = String(body?.userId ?? "default-user");
        const muted = body?.muted !== false;
        requireMember(convId, userId);
        imService.muteConversation(convId, userId, muted);
        json(200, { ok: true });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 表情回应
  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/im\/messages\/\d+\/reactions$/)) {
    readJson(req).then((body) => {
      try {
        const msgId = Number(reqUrl.pathname.split("/")[4]);
        const userId = String(body?.userId ?? "default-user");
        const emoji = String(body?.emoji ?? "");
        const message = imService.getMessage(msgId);
        if (!message) throw new Error("message not found");
        requireMember(message.conversationId, userId);
        if (body?.remove) {
          imService.removeReaction(msgId, userId, emoji);
        } else {
          imService.addReaction(msgId, userId, emoji);
        }
        json(200, { ok: true });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 置顶消息
  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/im\/messages\/\d+\/pin$/)) {
    readJson(req).then((body) => {
      try {
        const msgId = Number(reqUrl.pathname.split("/")[4]);
        const pinned = body?.pinned !== false;
        const message = imService.getMessage(msgId);
        if (!message) throw new Error("message not found");
        requireMember(message.conversationId, String(body?.userId || "default-user"));
        imService.pinMessage(msgId, pinned);
        json(200, { ok: true });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 获取置顶消息
  if (req.method === "GET" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/pinned$/)) {
    try {
      const convId = reqUrl.pathname.split("/")[4];
      const messages = imService.getPinnedMessages(convId);
      json(200, { ok: true, data: messages });
    } catch (e) { fail(e); }
    return;
  }

  // ─── 气泡拆分 API ──────────────────────────────────────

  // 预览气泡拆分（不写入，仅返回拆分结果）
  if (req.method === "POST" && reqUrl.pathname === "/api/im/messages/split-preview") {
    readJson(req).then((body) => {
      try {
        const content = String(body?.content ?? "");
        const result = splitIntoBubbles(content, {
          maxBubbles: Number(body?.maxBubbles ?? 4),
          minChars: Number(body?.minChars ?? 50),
        });
        json(200, { ok: true, data: result });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // 发送气泡拆分后的多条消息
  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/messages\/split$/)) {
    readJson(req).then((body) => {
      try {
        const parts = reqUrl.pathname.split("/");
        const convId = parts[4];
        const content = String(body?.content ?? "");
        const replyGroupId = randomUUID();
        const split = splitIntoBubbles(content, { replyGroupId });

        const messages = split.parts.map((part) =>
          imService.sendMessage(convId, {
            senderId: String(body?.senderId ?? "default-user"),
            senderType: body?.senderType === "agent" ? "agent" : "user",
            role: body?.role === "assistant" ? "assistant" : "user",
            content: part,
            replyGroupId,
          })
        );

        json(200, { ok: true, data: { replyGroupId, messages } });
      } catch (e) { fail(e); }
    }).catch(fail);
    return;
  }

  // ─── 侧链 API ──────────────────────────────────────────

  // 创建侧链
  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/sidechains$/)) {
    try {
      const convId = reqUrl.pathname.split("/")[4];
      requireMember(convId, reqUrl.searchParams.get("user_id") || "default-user");
      const sidechainId = imService.createSidechain(convId);
      json(200, { ok: true, data: { sidechainId } });
    } catch (e) { fail(e); }
    return;
  }

  // 获取侧链消息
  if (req.method === "GET" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/sidechains\/[^/]+$/)) {
    try {
      const parts = reqUrl.pathname.split("/");
      const convId = parts[4];
      const sidechainId = parts[6];
      const messages = imService.getSidechainMessages(convId, sidechainId);
      json(200, { ok: true, data: messages });
    } catch (e) { fail(e); }
    return;
  }

  // 列出侧链
  if (req.method === "GET" && reqUrl.pathname.match(/^\/api\/im\/conversations\/[^/]+\/sidechains$/)) {
    try {
      const convId = reqUrl.pathname.split("/")[4];
      const sidechains = imService.listSidechains(convId);
      json(200, { ok: true, data: sidechains });
    } catch (e) { fail(e); }
    return;
  }

  // ─── Handoff 跨 Agent 接力 API ──────────────────────────

  if (req.method === "POST" && ["/api/im/handoffs/preview", "/api/im/handoffs"].includes(reqUrl.pathname)) {
    readJson(req).then(async body => {
      const userId = String(body?.userId || "default-user");
      if (body?.mode === "llm" && deps.capabilities && !(await deps.capabilities()).llmConfigured) throw new Error("LLM summary unavailable: configure a default model and API key first");
      const conversationId = String(body?.conversationId || "");
      if (!imService.isMember(conversationId, userId)) throw new Error("not a member of source conversation");
      const targetId = body?.targetAgent === "claude-code" ? "claude" : String(body?.targetAgent || "");
      const target = deps.agents?.().find(agent => agent.id === targetId && agent.enabled);
      if (!target) throw new Error("target agent is unavailable; check agent settings");
      let snapshot: HandoffSnapshot;
      if (body?.previewId) {
        const preview = previews.get(String(body.previewId));
        if (!preview || preview.expires < Date.now() || preview.userId !== userId ||
          preview.snapshot.source.conversationId !== conversationId || preview.snapshot.target !== targetId) {
          throw new Error("preview expired or belongs to another request; prepare a new preview");
        }
        snapshot = preview.snapshot;
      } else {
        snapshot = await handoffService.prepareHandoffAsync(conversationId, String(body?.sourceAgentId || userId), targetId, {
          mode: body?.mode === "llm" ? "llm" : "rules", handoffNote: String(body?.handoffNote || "").slice(0, 8000),
          projectPath: String(body?.projectPath || deps.tasks?.settings(conversationId).cwd || ""),
        });
      }
      if (reqUrl.pathname.endsWith("/preview")) {
        for (const [id, preview] of previews) if (preview.expires < Date.now()) previews.delete(id);
        if (previews.size >= 100) previews.delete(previews.keys().next().value!);
        const previewId = randomUUID();
        previews.set(previewId, { snapshot, userId, expires: Date.now() + 10 * 60_000 });
        json(200, { ok: true, data: { previewId, snapshot, rendered: handoffService.renderPreview(snapshot) } });
        return;
      }
      if (!deps.tasks) throw new Error("task execution unavailable");
      const result = handoffService.executeHandoff(snapshot);
      let link = handoffService.taskLink(snapshot.snapshotId);
      if (!link) {
        const targetConversation = imService.createDm({ userId, targetId, targetType: "bot" });
        const settings = { ...deps.tasks.settings(conversationId), cwd: snapshot.source.projectPath || deps.tasks.settings(conversationId).cwd, leadAgentId: targetId };
        const message = imService.sendMessage(targetConversation.id, {
          senderId: userId, senderType: "user", role: "user", content: result.renderedContent,
          clientRequestId: `handoff:${snapshot.snapshotId}`, metadata: { handoffSnapshotId: snapshot.snapshotId, handoffExecution: settings },
        });
        const task = deps.tasks.enqueue(message);
        if (!task) throw new Error("target conversation does not contain the selected Bot");
        handoffService.linkTask(snapshot.snapshotId, task.id, targetConversation.id);
        link = { taskId: task.id, targetConversationId: targetConversation.id };
      }
      json(200, { ok: true, data: { ...result, ...link, status: deps.tasks.get(link.taskId)?.status || "queued" } });
    }).catch(fail);
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/im/handoffs") {
    try {
      const conversationId = reqUrl.searchParams.get("conversation_id") || undefined;
      const userId = reqUrl.searchParams.get("user_id") || "default-user";
      const records = handoffService.listHandoffs(conversationId, 100)
        .filter(record => imService.isMember(record.snapshot.source.conversationId, userId))
        .map(record => {
          const link = handoffService.taskLink(record.snapshot.snapshotId);
          return { ...record, ...link, status: link ? deps.tasks?.get(link.taskId)?.status || "unknown" : "pending" };
        });
      json(200, { ok: true, data: records });
    } catch (error) { fail(error); }
    return;
  }

  json(404, { ok: false, error: "IM endpoint not found" });
  };
}
