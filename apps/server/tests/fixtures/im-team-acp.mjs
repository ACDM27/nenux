import { createInterface } from "node:readline";
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const pending = new Map();
let permissionId = 10000;
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  if (!method && pending.has(id)) { const resume = pending.get(id); pending.delete(id); resume(); return; }
  if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] } });
  else if (method === "session/new") send({ id, result: { sessionId: `im-${process.pid}` } });
  else if (method === "session/prompt") {
    const context = JSON.parse(params.prompt.at(-1).text.split("\n").find(line => line.startsWith('{"')));
    const text = context.task === "group_dispatch"
      ? JSON.stringify(context.completedTurns.length ? { mode: "none", memberIds: [], triggerMessageIds: [] }
        : { mode: "sequential", memberIds: [context.members[0].id, context.members[1].id, context.members[0].id], triggerMessageIds: [context.messages.at(-1).id] })
      : `${context.currentBot.name}: verified reply for round ${context.turn?.round || 1}`;
    const finish = () => { send({ method: "session/update", params: { sessionId: `im-${process.pid}`, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text },
    } } });
    send({ id, result: { stopReason: "end_turn" } }); };
    if (context.originalRequest?.includes("IM_ACCEPTANCE_PERMISSION")) {
      const requestId = ++permissionId;
      pending.set(requestId, finish);
      send({ id: requestId, method: "session/request_permission", params: { sessionId: `im-${process.pid}`,
        toolCall: { toolCallId: "acceptance-read", title: "验收：读取测试文件", kind: "read", status: "pending" },
        options: [{ optionId: "allow", name: "允许本次测试", kind: "allow_once" }, { optionId: "reject", name: "拒绝", kind: "reject_once" }],
      } });
    } else if (!context.originalRequest?.includes("IM_ACCEPTANCE_WAIT")) finish();
  } else if (method === "session/cancel") {
    pending.clear();
    if (id !== undefined) send({ id, result: {} });
  } else if (id !== undefined) send({ id, result: {} });
});
