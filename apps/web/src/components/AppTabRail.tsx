import { useI18n } from "../i18n";
import { unreadAgentMessages } from "../agentPrivateMessages";
import { useStore } from "../state/store";
import { toggleWorkspaceSwitcher } from "../workspaceSwitcherEvents";
import { AgentIcon, TerminalIcon, DirectChatIcon } from "./icons";

export type AppTab = "pages" | "agents" | "messages";

/** Top-level product navigation. It stays visible in both workspaces, so Pages
 * and Agent conversations feel like peer destinations rather than a pane mode. */
export function AppTabRail({
  active,
  workspaceId,
  onChange,
}: {
  active: AppTab;
  workspaceId: string;
  onChange: (tab: AppTab) => void;
}) {
  const { t } = useI18n();
  const workspaces = useStore((state) => state.workspaces);
  const conversations = useStore((state) => state.agentConversations);
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0];
  const workspaceInitial = workspace.title.trim().charAt(0).toUpperCase() || "?";
  const firstWorkspaceId = workspaces[0]?.id ?? "";
  const unread = conversations
    .filter((conversation) => (conversation.workspaceId ?? firstWorkspaceId) === workspaceId)
    .reduce((total, conversation) => total + unreadAgentMessages(conversation), 0);

  return (
    <nav className="app-tab-rail" aria-label={t("kb.group.navigation")}>
      <div className="app-tab-mark" aria-hidden="true">T</div>
      <button
        className={`app-tab-button app-tab-pages ${active === "pages" ? "active" : ""}`}
        aria-label={t("sidebar.pages")}
        aria-current={active === "pages" ? "page" : undefined}
        title={t("sidebar.pages")}
        onClick={() => onChange("pages")}
      >
        <span className="app-tab-icon" aria-hidden="true">
          <TerminalIcon />
        </span>
      </button>
      <button
        className={`app-tab-button app-tab-agents ${active === "agents" ? "active" : ""}`}
        aria-label={unread ? `${t("agentWorkspace.bots")}, ${t("agentWorkspace.unread", { n: unread })}` : t("agentWorkspace.bots")}
        aria-current={active === "agents" ? "page" : undefined}
        title={t("agentWorkspace.bots")}
        onClick={() => onChange("agents")}
      >
        <span className="app-tab-icon" aria-hidden="true">
          <AgentIcon />
          {unread > 0 && <span className="app-tab-unread">{unread > 99 ? "99+" : unread}</span>}
        </span>
      </button>
      <button
        className={`app-tab-button app-tab-messages ${active === "messages" ? "active" : ""}`}
        aria-label="IM Messages"
        aria-current={active === "messages" ? "page" : undefined}
        title="IM Messages"
        onClick={() => onChange("messages")}
      >
        <span className="app-tab-icon" aria-hidden="true">
          <DirectChatIcon />
        </span>
      </button>
      <button
        className="app-tab-button app-tab-workspace"
        aria-label={workspace.title}
        title={workspace.title}
        onClick={toggleWorkspaceSwitcher}
      >
        <span className={`app-tab-workspace-avatar${workspace.icon ? " emoji" : ""}`}>
          {workspace.icon ?? workspaceInitial}
        </span>
      </button>
    </nav>
  );
}
