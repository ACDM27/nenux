import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { createImHttpHandler } from "./imRoutes.js";
import { ImService, migrateImSchema } from "./imService.js";
import { HandoffService } from "./imHandoff.js";

test("IM HTTP mutations use resource IDs and persist the expected changes", async t => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrateImSchema(db);
  const service = new ImService(db);
  const handler = createImHttpHandler({ imService: service, handoffService: new HandoffService(db, service),
    capabilities: async () => ({ llmConfigured: false, agents: [] }),
    readJson: async req => { let body = ""; for await (const part of req) body += part; return JSON.parse(body || "{}"); } });
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const address = server.address() as { port: number };
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/im${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.data;
  };
  const conv = await request("/conversations/dm", "POST", { userId: "a", targetId: "b" });
  const prefix = `/conversations/${conv.id}`;
  assert.equal((await request(`${prefix}/members?user_id=a`))[1].userOrBotId, "b");
  assert.equal((await request("/contacts")).some((contact: any) => contact.id === "b"), true);
  const group = await request("/conversations/group", "POST", { title: "Team", ownerId: "a", members: [{ id: "b", type: "user" }] });
  assert.equal(group.memberCount, 2);
  assert.equal(service.isMember(group.id, "a"), true);
  assert.equal((await request("/capabilities")).llmConfigured, false);
  const groupPrefix = `/conversations/${group.id}`;
  await request(`${groupPrefix}/members`, "DELETE", { userId: "a", targetId: "b" });
  assert.equal(service.isMember(group.id, "b"), false);
  await request(`${groupPrefix}/members`, "POST", { userId: "a", targetId: "b" });
  assert.equal(service.isMember(group.id, "b"), true);
  for (const body of [{ userId: "b", targetId: "a" }, { userId: "a", targetId: "a" }]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/im${groupPrefix}/members`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 403);
  }
  const noLlm = await fetch(`http://127.0.0.1:${address.port}/api/im/handoffs/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "a", conversationId: group.id, mode: "llm" }),
  });
  assert.equal(noLlm.status, 400);
  assert.match((await noLlm.json() as any).error, /configure a default model/);
  const msg = await request(`${prefix}/messages`, "POST", { senderId: "a", content: "original", clientRequestId: "send-1", replyGroupId: "reply-1" });
  const duplicate = await request(`${prefix}/messages`, "POST", { senderId: "a", content: "original", clientRequestId: "send-1" });
  assert.equal(duplicate.id, msg.id);
  assert.equal(msg.replyGroupId, "reply-1");
  await request(`${prefix}/read`, "POST", { userId: "b", seq: msg.seq });
  assert.equal(service.getConversationState(conv.id, "b").lastReadSeq, msg.seq);
  await request(`${prefix}/pin`, "POST", { userId: "a", pinned: true });
  await request(`${prefix}/mute`, "POST", { userId: "a", muted: true });
  assert.equal(service.getConversationState(conv.id, "a").pinned, true);
  assert.equal(service.getConversationState(conv.id, "a").muted, true);
  const privateConv = service.createDm({ userId: "outsider", targetId: "other", targetType: "user" });
  service.sendMessage(privateConv.id, { senderId: "outsider", senderType: "user", role: "user", content: "confidential needle" });
  assert.equal((await request("/search?q=confidential&user_id=a")).length, 0);
  assert.equal((await request("/search?q=confidential&user_id=outsider")).length, 1);
  const forbiddenSearch = await fetch(`http://127.0.0.1:${address.port}/api/im/search?q=needle&conversation_id=${privateConv.id}&user_id=a`);
  assert.equal(forbiddenSearch.status, 403);
  for (const [path, method, body] of [
    [`${prefix}/messages?user_id=outsider`, "GET", undefined],
    [`${prefix}/pinned?user_id=outsider`, "GET", undefined],
    [`${prefix}/pin`, "POST", { userId: "outsider" }],
    [`/messages/${msg.id}/pin`, "POST", { userId: "outsider" }],
    [`/messages/${msg.id}/reactions`, "POST", { userId: "outsider", emoji: "👍" }],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/im${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 403, path);
  }
  const edited = await request(`/messages/${msg.id}`, "PUT", { senderId: "a", content: "edited" });
  assert.equal(edited.content, "edited");
  await request(`/messages/${msg.id}/reactions`, "POST", { userId: "b", emoji: "👍" });
  await request(`/messages/${msg.id}/pin`, "POST", { pinned: true, userId: "a" });
  assert.equal((await request(`${prefix}/pinned?user_id=a`))[0].id, msg.id);
  const sidechain = await request(`${prefix}/sidechains?user_id=a`, "POST", {});
  await request(`${prefix}/messages`, "POST", { senderId: "a", content: "side", sidechainId: sidechain.sidechainId });
  assert.equal((await request(`${prefix}/sidechains/${sidechain.sidechainId}?user_id=a`)).length, 1);
  await request(`${prefix}/sidechains?user_id=a`);
  await request(`/messages/${msg.id}?sender_id=a`, "DELETE");
  const history = await request(`${prefix}/messages?user_id=a`);
  assert.equal(history.items.some((m: any) => m.id === msg.id), false);
  assert.equal((db.prepare("SELECT is_deleted FROM im_message WHERE id = ?").get(msg.id) as any).is_deleted, 1);
});
