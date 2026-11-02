import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ImService, migrateImSchema } from "./imService.js";
import { ImTaskService } from "./imTasks.js";
import { createImAgentExecutor } from "./imAgentExecution.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function until(predicate: () => boolean) {
  for (let count = 0; count < 200; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("task did not reach expected state");
}

test("successful checkpoints survive closing and reopening the database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "termany-im-recovery-"));
  let db = new DatabaseSync(join(dir, "tasks.sqlite")); migrateImSchema(db);
  let im = new ImService(db);
  const conv = im.createDm({ userId: "human", targetId: "bot", targetType: "bot" });
  let calls = 0;
  let tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: async ({ checkpoint }) => {
    calls++; checkpoint!.save("finished-step", "durable result"); throw new Error("next step interrupted");
  } });
  try {
    const task = tasks.enqueue(im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: "work" }))!;
    await until(() => tasks.get(task.id)?.status === "failed");
    tasks.stop(); db.close();
    db = new DatabaseSync(join(dir, "tasks.sqlite")); im = new ImService(db);
    tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: async ({ checkpoint }) => {
      assert.deepEqual(checkpoint!.load("finished-step"), { output: "durable result", taskId: task.id });
      assert.equal(checkpoint!.load("different-input"), null);
      return null;
    } });
    const retry = tasks.retry(task.id);
    await until(() => tasks.get(retry.id)?.status === "succeeded");
    assert.equal(calls, 1);
    assert.equal(tasks.get(retry.id)?.parentTaskId, task.id);
  } finally { tasks.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("one Bot keeps two groups and a DM in separate runtime sessions", async t => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conversations = [
    im.createGroup({ title: "A", ownerId: "human", members: [{ id: "bot", type: "bot" }] }),
    im.createGroup({ title: "B", ownerId: "human", members: [{ id: "bot", type: "bot" }] }),
    im.createDm({ userId: "human", targetId: "bot", targetType: "bot" }),
  ];
  const sessions = new Set<string>();
  const markers = ["PRIVATE_A_MARKER", "PRIVATE_B_MARKER", "PRIVATE_DM_MARKER"];
  const tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: createImAgentExecutor({
    im, agents: () => [{ id: "bot", name: "Bot", enabled: true }], prompt: async input => {
      sessions.add(input.paneId);
      assert.equal(markers.filter(marker => input.prompt.includes(marker)).length, 1);
      input.delta("isolated response");
    },
  }) });
  t.after(() => { tasks.stop(); db.close(); });
  const queued = conversations.map((conv, i) => tasks.enqueue(im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: markers[i] }))!);
  await until(() => queued.every(task => tasks.get(task.id)?.status === "succeeded"));
  assert.equal(sessions.size, 3);
});

test("group turn budget stops execution with a visible failure", async t => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conv = im.createGroup({ title: "Budget", ownerId: "human", members: [{ id: "r", type: "bot" }, { id: "w", type: "bot" }] });
  let replies = 0;
  const tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: createImAgentExecutor({
    im, agents: () => [{ id: "r", name: "Researcher", enabled: true }, { id: "w", name: "Writer", enabled: true }], prompt: async input => {
      if (input.prompt.includes('"task":"group_dispatch"')) input.delta(JSON.stringify({ mode: "sequential", memberIds: ["r", "w", "r"], triggerMessageIds: ["1"] }));
      else { replies++; input.delta("partial output"); }
    },
  }) });
  t.after(() => { tasks.stop(); db.close(); });
  tasks.configure(conv.id, { cwd: ".", maxTurns: 1, timeoutMs: 5000 });
  const task = tasks.enqueue(im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: "work" }))!;
  await until(() => tasks.get(task.id)?.status === "failed");
  assert.equal(replies, 1);
  assert.match(tasks.get(task.id)!.error!, /轮数上限/);
  assert.equal(tasks.get(task.id)!.steps[0].status, "succeeded");
});

test("execution settings validate directories and leaders and are frozen when queued", () => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conv = im.createDm({ userId: "human", targetId: "bot", targetType: "bot" });
  const tasks = new ImTaskService(db, im, { defaultCwd: ".", autoStart: false, execute: async () => null });
  try {
    const settings = { cwd: ".", maxTurns: 3, timeoutMs: 5000, leadAgentId: "bot" };
    assert.throws(() => tasks.configure(conv.id, { ...settings, cwd: "missing-directory-for-im-test" }), /directory/);
    assert.throws(() => tasks.configure(conv.id, { ...settings, leadAgentId: "outsider" }), /lead agent/);
    assert.throws(() => tasks.configure(conv.id, { ...settings, maxTurns: 0 }), /maxTurns/);
    tasks.configure(conv.id, settings);
    const task = tasks.enqueue(im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: "work" }))!;
    tasks.configure(conv.id, { ...settings, maxTurns: 5 });
    assert.equal(tasks.get(task.id)?.executionSettings?.maxTurns, 3);
    assert.equal(tasks.settings(conv.id).maxTurns, 5);
  } finally { tasks.stop(); db.close(); }
});

test("permission responses only accept a pending task option and cannot be reused", async t => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conv = im.createDm({ userId: "human", targetId: "bot", targetType: "bot" });
  const tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: async ({ signal, progress }) => {
    progress([{ agentId: "bot", status: "running", text: "waiting", permission: {
      paneId: "pane", requestId: "request", title: "Read file", options: [{ optionId: "allow", name: "Allow" }],
    } }]);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted(); return null;
  } });
  t.after(() => { tasks.stop(); db.close(); });
  const task = tasks.enqueue(im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: "work" }))!;
  await until(() => !!tasks.get(task.id)?.steps[0]?.permission);
  let replies = 0;
  const respond = (pane: string, request: string, option: string) => {
    assert.deepEqual([pane, request, option], ["pane", "request", "allow"]); replies++; return true;
  };
  assert.throws(() => tasks.respondPermission(task.id, "request", "invented", respond), /not found/);
  tasks.respondPermission(task.id, "request", "allow", respond);
  assert.throws(() => tasks.respondPermission(task.id, "request", "allow", respond), /not found/);
  assert.equal(replies, 1);
  tasks.cancel(task.id);
  await new Promise(resolve => setTimeout(resolve, 20));
});

test("retry reuses successful persisted team steps and messages across attempts", async t => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conv = im.createGroup({ title: "Recovery", ownerId: "human", members: [{ id: "r", type: "bot" }, { id: "w", type: "bot" }] });
  const calls = { r: 0, w: 0, controller: 0 };
  const tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: createImAgentExecutor({
    im, agents: () => [{ id: "r", name: "Researcher", enabled: true }, { id: "w", name: "Writer", enabled: true }],
    prompt: async input => {
      if (input.prompt.includes('"task":"group_dispatch"')) {
        calls.controller++;
        const payload = JSON.parse(input.prompt.split("\n").find(line => line.startsWith('{"task"'))!);
        input.delta(JSON.stringify(payload.completedTurns.length ? { mode: "none", memberIds: [], triggerMessageIds: [] }
          : { mode: "sequential", memberIds: ["r", "w", "r"], triggerMessageIds: [String(payload.messages[0].id)] }));
      } else if (input.agentId === "r") { calls.r++; input.delta("Research result"); }
      else { if (++calls.w === 1) throw new Error("writer disconnected"); input.delta("Writing result"); }
    },
  }) });
  t.after(() => { tasks.stop(); db.close(); });
  const first = tasks.enqueue(im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: "Complete research and writing" }))!;
  await until(() => tasks.get(first.id)?.status === "failed");
  assert.equal(calls.r, 1);
  const originalReply = im.getMessages(conv.id).items.find(item => item.senderId === "r")!;
  const second = tasks.retry(first.id);
  await until(() => tasks.get(second.id)?.status === "succeeded");
  assert.equal(calls.r, 2, "only consolidation calls Researcher again; completed research is reused");
  assert.equal(calls.w, 2);
  assert.equal(tasks.get(second.id)?.steps[0].reusedFromTaskId, first.id);
  const replies = im.getMessages(conv.id).items.filter(item => item.senderType === "agent");
  assert.equal(replies.length, 3, "replayed replies retain their original IDs instead of creating duplicates");
  assert.equal(replies[0].id, originalReply.id);
});

test("IM message transaction queues once; existing group engine produces persisted specialist and lead replies", async t => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conversation = im.createGroup({ title: "Team", ownerId: "human", members: [
    { id: "r", type: "bot" }, { id: "w", type: "bot" },
  ] });
  let decisions = 0;
  const tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: createImAgentExecutor({
    im, agents: () => [{ id: "r", name: "Researcher", enabled: true }, { id: "w", name: "Writer", enabled: true }],
    prompt: async input => {
      if (input.prompt.includes('"task":"group_dispatch"')) {
        decisions++;
        input.delta(JSON.stringify(decisions === 1 ? { mode: "sequential", memberIds: ["r", "w", "r"], triggerMessageIds: ["1"] }
          : { mode: "none", memberIds: [], triggerMessageIds: [] }));
      } else input.delta(input.agentId === "w" ? "Specialist result" : "Lead response");
    },
  }) });
  im.onMessagePersisted = message => { tasks.enqueue(message); };
  t.after(() => { tasks.stop(); db.close(); });
  const send = () => im.sendMessage(conversation.id, { senderId: "human", senderType: "user", role: "user", content: "Complete a team task", clientRequestId: "request-1" });
  const message = send(); send();
  assert.equal(tasks.list(conversation.id).length, 1);
  await until(() => tasks.list(conversation.id)[0].status === "succeeded");
  const task = tasks.list(conversation.id)[0];
  assert.equal(task.triggerMessageId, message.id);
  assert.deepEqual(task.steps.map(step => step.agentId), ["r", "w", "r"]);
  assert.ok(task.resultMessageId);
  assert.deepEqual(im.getMessages(conversation.id).items.slice(1).map(item => item.senderId), ["r", "w", "r"]);
  assert.equal(tasks.list(conversation.id).length, 1, "assistant replies must not trigger execution loops");
});

test("failed tasks retry as a new attempt; cancellation aborts execution and never succeeds later", async t => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conv = im.createDm({ userId: "human", targetId: "bot", targetType: "bot" });
  let attempts = 0;
  const tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: async ({ signal }) => {
    if (++attempts === 1) throw new Error("model unavailable");
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
    return 42;
  } });
  t.after(() => { tasks.stop(); db.close(); });
  const message = im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: "work" });
  const first = tasks.enqueue(message)!;
  await until(() => tasks.get(first.id)?.status === "failed");
  assert.match(tasks.get(first.id)!.error!, /model unavailable/);
  const second = tasks.retry(first.id);
  assert.equal(second.attempt, 2);
  assert.equal(second.parentTaskId, first.id);
  await until(() => tasks.get(second.id)?.status === "running");
  tasks.cancel(second.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(tasks.get(second.id)?.status, "cancelled");
});

test("restart marks abandoned executions as interrupted without replaying external work", () => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conv = im.createDm({ userId: "human", targetId: "bot", targetType: "bot" });
  const first = new ImTaskService(db, im, { defaultCwd: ".", execute: async () => null, autoStart: false });
  const message = im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: "work" });
  const task = first.enqueue(message)!;
  first.stop();
  db.prepare("UPDATE im_task SET status='running' WHERE id=?").run(task.id);
  const restarted = new ImTaskService(db, im, { defaultCwd: ".", execute: async () => null, autoStart: false });
  assert.equal(restarted.get(task.id)?.status, "failed");
  assert.match(restarted.get(task.id)!.error!, /重启中断/);
  restarted.stop(); db.close();
});

test("task deadlines abort the runtime and persist a timeout failure", async t => {
  const db = new DatabaseSync(":memory:"); migrateImSchema(db);
  const im = new ImService(db);
  const conv = im.createDm({ userId: "human", targetId: "bot", targetType: "bot" });
  let aborted = false;
  const tasks = new ImTaskService(db, im, { defaultCwd: ".", execute: async ({ signal }) => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    throw new Error("Active session disposed");
  } });
  t.after(() => { tasks.stop(); db.close(); });
  tasks.configure(conv.id, { cwd: ".", maxTurns: 1, timeoutMs: 1000 });
  const task = tasks.enqueue(im.sendMessage(conv.id, { senderId: "human", senderType: "user", role: "user", content: "work" }))!;
  await until(() => tasks.get(task.id)?.status === "failed");
  assert.equal(aborted, true);
  assert.match(tasks.get(task.id)!.error!, /超时/);
});
