import {
  groupControllerSessionId, groupDecisionPrompt, groupMemberSessionId,
  groupConversationPrompt, runGroupConversation, splitGroupReply,
} from "../../web/src/agentGroupChat.js";
import type { AgentConversation, AgentMessage } from "../../web/src/state/store.js";
import type { ImService } from "./imService.js";
import type { ImTaskExecution, ImTaskStep } from "./imTasks.js";
import type { ImAttachmentService } from "./imAttachments.js";
import { createHash } from "node:crypto";

export interface ImAgentPrompt {
  agentId: string; paneId: string; cwd: string; prompt: string; signal: AbortSignal;
  delta: (text: string) => void;
  images?: Array<{ path: string; mimeType: string }>;
  permission: (request: NonNullable<ImTaskStep["permission"]>) => void;
}

/** Adapt persisted IM conversations to the existing group routing engine. */
export function createImAgentExecutor(deps: {
  im: ImService;
  agents: () => Array<{ id: string; name: string; enabled: boolean }>;
  prompt: (input: ImAgentPrompt) => Promise<void>;
  attachments?: ImAttachmentService;
}) {
  return async ({ task, message, settings, signal, progress, checkpoint }: ImTaskExecution): Promise<number | null> => {
    const available = deps.agents();
    const members: AgentConversation[] = deps.im.listMembers(task.conversationId)
      .filter(member => member.memberType === "bot")
      .map(member => {
        const config = available.find(agent => agent.id === member.userOrBotId);
        if (!config?.enabled) throw new Error(`智能体 ${member.userOrBotId} 不可用，请检查配置`);
        return { id: config.id, kind: "leaf", title: config.name, createdAt: 0, updatedAt: 0 } as AgentConversation;
      });
    if (!members.length) throw new Error("会话没有可执行智能体");
    const group = { name: deps.im.getConversation(task.conversationId)?.title || "IM", members,
      leadMemberId: settings.leadAgentId || members[0].id };
    if (!members.some(member => member.id === group.leadMemberId)) throw new Error("群负责人不在成员中");
    const sessionGroup = `im:${task.conversationId}:project:${encodeURIComponent(settings.cwd)}`;
    const source = deps.im.getMessages(task.conversationId, { beforeSeq: message.seq + 1, limit: 100 }).items;
    const history: AgentMessage[] = source.map(item => ({
      id: String(item.id), role: item.role === "assistant" ? "assistant" : "user", content: [item.content,
        ...(item.metadata.attachments || []).map(file => deps.attachments ? `Attached file ${file.name}: ${JSON.stringify(deps.attachments.filePath(deps.attachments.get(file.id, message.senderId).id))}` : `Attached file: ${file.name}`),
      ].join("\n"),
      createdAt: item.createdAt, sender: item.senderType === "agent" ? { id: item.senderId, name: available.find(a => a.id === item.senderId)?.name || item.senderId } : undefined,
    }));
    const user = history.find(item => item.id === String(message.id)) || {
      id: String(message.id), role: "user" as const, content: message.content, createdAt: message.createdAt,
    };
    const steps: ImTaskStep[] = [];
    let resultMessageId: number | null = null;
    let invocation = 0;
    const ask = async (agentId: string, paneId: string, prompt: string, visible: boolean) => {
      signal.throwIfAborted();
      const key = createHash("sha256").update(JSON.stringify([++invocation, agentId, settings, prompt])).digest("hex");
      const saved = checkpoint?.load(key);
      if (saved) {
        if (visible) { steps.push({ agentId, status: "succeeded", text: saved.output.slice(-50_000), reusedFromTaskId: saved.taskId }); progress(steps); }
        return { content: saved.output, sourceTaskId: saved.taskId };
      }
      let content = "";
      const step: ImTaskStep = { agentId, status: "running", text: "" };
      if (visible) { steps.push(step); progress(steps); }
      let lastProgress = 0;
      try {
        await deps.prompt({ agentId, paneId, cwd: settings.cwd,
          prompt: task.parentTaskId ? `${prompt}\n\nExplicit recovery: successful matching steps were reused. This step did not complete previously. Inspect current project state before retrying; do not repeat external side effects already performed by an interrupted attempt.` : prompt, signal,
          images: visible && deps.attachments ? message.metadata.attachments?.filter(file => file.mimeType.startsWith("image/")).map(file => ({ path: deps.attachments!.filePath(file.id), mimeType: file.mimeType })) : undefined,
          delta: text => {
          signal.throwIfAborted(); content += text;
          if (visible) {
            step.text = content.slice(-50_000);
            if (Date.now() - lastProgress > 150) { progress(steps); lastProgress = Date.now(); }
          }
        }, permission: request => {
          signal.throwIfAborted();
          if (!steps.includes(step)) steps.push(step);
          step.permission = request;
          progress(steps);
        } });
        signal.throwIfAborted();
        if (!content.trim()) throw new Error("智能体未返回内容");
        step.status = "succeeded";
        delete step.permission;
        if (visible) progress(steps);
        checkpoint?.save(key, content);
        return { content, sourceTaskId: task.id };
      } catch (error) {
        step.status = "failed"; step.error = error instanceof Error ? error.message : String(error);
        delete step.permission;
        if (visible) progress(steps);
        throw error;
      }
    };
    const reply = async (member: AgentConversation, prompt: string, round: number) => {
      const { content, sourceTaskId } = await ask(member.id, groupMemberSessionId(sessionGroup, member.id), prompt, true);
      const replies = splitGroupReply({ id: `${task.id}:${round}`, role: "assistant", content,
        createdAt: Date.now(), sender: { id: member.id, name: member.title } });
      for (const [index, item] of replies.entries()) {
        signal.throwIfAborted();
        const persisted = deps.im.sendMessage(task.conversationId, { senderId: member.id, senderType: "agent", role: "assistant",
          content: item.content, replyGroupId: `${sourceTaskId}:${round}`, clientRequestId: `${sourceTaskId}:${round}:${index}` });
        resultMessageId = persisted.id;
        item.id = String(persisted.id);
      }
      return replies;
    };
    if (members.length === 1) {
      await reply(members[0], groupConversationPrompt(group, members[0], history), 1);
    } else {
      const result = await runGroupConversation({ group, user, history, signal, maxTurns: settings.maxTurns,
        decide: async context => {
          const { content } = await ask(group.leadMemberId, groupControllerSessionId(sessionGroup), groupDecisionPrompt(group, context), false);
          return JSON.parse(content.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, ""));
        },
        reply: (member, turn, messages) => reply(member, groupConversationPrompt(group, member, messages, turn), turn.round),
      });
      if (result.limited) throw new Error("已达到协作轮数上限，请检查已完成步骤");
      if (result.failed) throw new Error("群协作失败，请检查成员配置和执行记录");
    }
    signal.throwIfAborted();
    if (!resultMessageId) throw new Error("协作未产生可见结果");
    return resultMessageId;
  };
}
