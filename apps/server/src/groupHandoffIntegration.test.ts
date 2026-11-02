import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { groupConversationPrompt, groupControllerSessionId, groupDecisionPrompt, groupMemberSessionId, runGroupConversation, splitGroupReply } from "../../web/src/agentGroupChat";
import type { AgentConversation, AgentMessage } from "../../web/src/state/store";

test("an isolated ACP controller supervises handoffs and confirms completion", { timeout: 20_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-handoff-"));
  const home = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  home.mock.restore();
  const { promptAcpRuntime, closeAllAcpRuntimes } = await import("./acpRuntime.js");
  t.after(async () => {
    closeAllAcpRuntimes();
    db.getDb().close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  db.setAgentsRaw(JSON.stringify([{
    id: "test", name: "Test", command: process.execPath, args: "", enabled: true,
    runtime: { protocol: "acp", distribution: "custom", modelSource: "agent", command: process.execPath,
      args: JSON.stringify(fileURLToPath(new URL("../tests/fixtures/group-handoff-acp.mjs", import.meta.url))) },
  }]));
  const members: AgentConversation[] = ["Researcher", "Writer", "Observer"].map((title, index) => ({
    kind: "leaf", id: String.fromCharCode(97 + index), title, workspaceId: "ws", createdAt: 1, updatedAt: 1,
  }));
  const group = { name: "Team", members };
  const user: AgentMessage = { id: "u", role: "user", content: "Start the discussion", createdAt: 1 };
  const history = [user];
  const abort = new AbortController();
  let decisions = 0;
  const result = await runGroupConversation({ group, user, signal: abort.signal,
    decide: async (context) => {
      decisions++;
      let content = "";
      await promptAcpRuntime({ paneId: groupControllerSessionId("group"), agentId: "test", cwd: directory,
        prompt: groupDecisionPrompt(group, context), signal: abort.signal,
        emit: (event) => { if (event.type === "delta") content += event.text; } });
      return JSON.parse(content);
    }, reply: async (member, turn) => {
    let content = "";
    await promptAcpRuntime({ paneId: groupMemberSessionId("group", member.id), agentId: "test", cwd: directory,
      prompt: groupConversationPrompt(group, member, history, turn), botIdentity: { name: member.title },
      signal: abort.signal, applySavedConfig: true,
      emit: (event) => { if (event.type === "delta") content += event.text; } });
    const replies = splitGroupReply({ id: `${member.id}-${turn.round}`, role: "assistant", content, createdAt: turn.round,
      sender: { id: member.id, name: member.title } });
    history.push(...replies);
    return replies;
  } });
  assert.equal(result.limited, false);
  assert.equal(decisions, 2, "the controller routes once, then verifies the completed handoff chain");
  assert.deepEqual(history.slice(1).map((message) => message.sender?.id), ["a", "a", "b", "a"]);
  assert.equal(history[1].content, "First finding");
  assert.match(history[3].content, /Checked: @Writer Check the finding/);
  assert.equal(history[4].content, "Final result after 2 turns: Writer");
  assert.equal(new Set(history.map((message) => message.id)).size, history.length);
});
