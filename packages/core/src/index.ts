export type { ITerminalBackend, ClientMessage, ShellExit } from "./backend.js";
export { SHELL_EXIT_CLOSE_CODE, encodeShellExit, parseShellExit } from "./backend.js";
export { WebSocketBackend } from "./ws-backend.js";
export type { BotIdentity } from "./bot.js";
export { AGENT_RUNTIME_REVISION, defaultAgentRuntime, inheritsDefaultAgentRuntime } from "./agentRuntime.js";
export type { AgentRuntimeConfig } from "./agentRuntime.js";
export { CODEX_SKILL_BUDGET_NOTICE, splitAgentRuntimeNotices } from "./agentDiagnostics.js";

// IM 消息系统类型
export type {
  ImConversation,
  ImMessage,
  ImMember,
  ImConversationState,
  ImReaction,
  ImEventOutbox,
  ImHandoff,
  SendMessageRequest,
  CreateDmRequest,
  CreateGroupRequest,
  CursorPage,
  UnreadCount,
  SearchResult,
  SearchRequest,
  MessageMetadata,
  ImApiResponse,
} from "./imTypes.js";
export { ImEventType } from "./imTypes.js";
