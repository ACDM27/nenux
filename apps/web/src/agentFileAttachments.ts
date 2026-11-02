import type { AgentFileAttachment, AgentMessage } from "./state/store";
import { uuid } from "./uuid";

export function fileAttachmentName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function createAgentFileAttachment(path: string): AgentFileAttachment {
  return {
    id: uuid(),
    kind: "file",
    path,
    name: fileAttachmentName(path),
  };
}

/** Preserve clean display text while still giving the runtime exact local
 * paths it can inspect with its file tools. */
export function agentMessagePromptContent(message: Pick<AgentMessage, "content" | "files" | "replyTo">): string {
  const reply = message.replyTo?.content.trim();
  const context = reply
    ? `Replying to this earlier message:\n${reply.split("\n").map((line) => `> ${line}`).join("\n")}`
    : "";
  const content = [context, message.content].filter(Boolean).join("\n\n");
  if (!message.files?.length) return content;
  const paths = message.files.map((file) => JSON.stringify(file.path)).join("\n");
  return [content, "Attached files:", paths].filter(Boolean).join("\n");
}
