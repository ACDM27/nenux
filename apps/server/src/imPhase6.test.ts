/**
 * 阶段六测试：气泡拆分 + 侧链 + 消息置顶独立列
 *
 * 运行: node --import tsx apps/server/src/imPhase6.test.ts
 */

import { DatabaseSync } from "node:sqlite";
import { migrateImSchema, ImService } from "./imService.js";
import { splitIntoBubbles, MESSAGE_BREAK } from "./imBubbleSplit.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(name: string): void { console.log(`\n── ${name} ──`); }

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrateImSchema(db);
  return db;
}

// ─── 气泡拆分单元测试 ───────────────────────────────────

function testBubbleSplit(): void {
  section("Bubble Split Algorithm");

  // AC-6.1: 显式分隔符拆分
  const r1 = splitIntoBubbles(`第一段内容\n${MESSAGE_BREAK}\n第二段内容\n${MESSAGE_BREAK}\n第三段`);
  assertEq(r1.parts.length, 3, "AC-6.1a: 显式分隔符拆为 3 段");
  assert(r1.parts[0].includes("第一段"), "AC-6.1b: 第一段内容正确");
  assert(r1.parts[2].includes("第三段"), "AC-6.1c: 第三段内容正确");

  // AC-6.2: 代码块不切断
  const codeContent = `这是一段说明文字\n\n\`\`\`python\nprint("hello")\nprint("world")\n\`\`\`\n\n这是代码后的说明`;
  const r2 = splitIntoBubbles(codeContent, { minChars: 10 });
  // 代码块应该完整保留在某个气泡中
  const hasFullCodeBlock = r2.parts.some((p) =>
    p.includes('```python') && p.includes('```')
  );
  assert(hasFullCodeBlock, "AC-6.2a: 代码块未被切断");

  // AC-6.3: replyGroupId 共享
  const r3 = splitIntoBubbles(`A\n${MESSAGE_BREAK}\nB\n${MESSAGE_BREAK}\nC`, { replyGroupId: "test-group-1" });
  assertEq(r3.replyGroupId, "test-group-1", "AC-6.3: replyGroupId 传递正确");

  // 最大气泡数限制
  const longContent = Array(10).fill("段落").join(`\n${MESSAGE_BREAK}\n`);
  const r4 = splitIntoBubbles(longContent, { maxBubbles: 3 });
  assert(r4.parts.length <= 3, `AC-6.4: maxBubbles=3 限制生效 (got ${r4.parts.length})`);

  // 单段不拆分
  const r5 = splitIntoBubbles("短消息");
  assertEq(r5.parts.length, 1, "AC-6.5: 短消息不拆分");

  // 表格不切断
  const tableContent = `说明文字\n\n| 列1 | 列2 |\n|-----|-----|\n| a | b |\n| c | d |\n\n后续说明`;
  const r6 = splitIntoBubbles(tableContent, { minChars: 10 });
  const hasFullTable = r6.parts.some((p) => p.includes("| 列1 |") && p.includes("| c |"));
  assert(hasFullTable, "AC-6.6: 表格未被切断");
}

// ─── 侧链集成测试 ─────────────────────────────────────

function testSidechains(): void {
  section("Sidechain Messages");

  const db = createTestDb();
  const im = new ImService(db);

  const conv = im.createGroup({
    title: "侧链测试群",
    ownerId: "user-a",
    members: [
      { id: "user-a", type: "user", role: "owner" },
      { id: "bot-1", type: "bot", role: "member" },
    ],
  });

  // 主线消息
  im.sendMessage(conv.id, { senderId: "user-a", senderType: "user", role: "user", content: "主线消息 1" });
  im.sendMessage(conv.id, { senderId: "user-a", senderType: "user", role: "user", content: "主线消息 2" });

  // AC-6.4a: 创建侧链
  const sidechainId = im.createSidechain(conv.id);
  assert(sidechainId.startsWith("sc_"), "AC-6.4a: 侧链 ID 格式正确");

  // AC-6.4b: 发送侧链消息
  im.sendMessage(conv.id, {
    senderId: "user-a", senderType: "user", role: "user",
    content: "侧链子任务消息 1",
    sidechainId,
  });
  im.sendMessage(conv.id, {
    senderId: "bot-1", senderType: "agent", role: "assistant",
    content: "侧链子任务回复",
    sidechainId,
  });

  // 再发一条主线
  im.sendMessage(conv.id, { senderId: "user-a", senderType: "user", role: "user", content: "主线消息 3" });

  // AC-6.4c: 获取侧链消息
  const sidechainMsgs = im.getSidechainMessages(conv.id, sidechainId);
  assertEq(sidechainMsgs.length, 2, "AC-6.4c: 侧链有 2 条消息");
  assert(sidechainMsgs.every((m) => m.sidechainId === sidechainId), "AC-6.4d: 全部属于同一侧链");

  // AC-6.4e: 列出侧链
  const sidechains = im.listSidechains(conv.id);
  assert(sidechains.includes(sidechainId), "AC-6.4e: listSidechains 包含新建的侧链");

  // 主线消息不包含侧链 ID
  const mainMsgs = im.getMessages(conv.id, { limit: 100 });
  const mainOnly = mainMsgs.items.filter((m) => m.sidechainId === null);
  assertEq(mainOnly.length, 3, "AC-6.4f: 主线有 3 条消息（不含侧链）");

  db.close();
}

// ─── 消息置顶独立列测试 ───────────────────────────────

function testPinnedColumn(): void {
  section("Message Pin (dedicated column)");

  const db = createTestDb();
  const im = new ImService(db);

  const conv = im.createGroup({
    title: "置顶测试",
    ownerId: "user-a",
    members: [{ id: "user-a", type: "user", role: "owner" }],
  });

  const msg1 = im.sendMessage(conv.id, { senderId: "user-a", senderType: "user", role: "user", content: "消息 A" });
  const msg2 = im.sendMessage(conv.id, { senderId: "user-a", senderType: "user", role: "user", content: "消息 B" });

  // 置顶 msg1
  im.pinMessage(msg1.id, true);

  // 验证 is_pinned 列
  const pinned = im.getPinnedMessages(conv.id);
  assertEq(pinned.length, 1, "AC-6.7a: 1 条置顶消息");
  assertEq(pinned[0].id, msg1.id, "AC-6.7b: 置顶的是 msg1");
  assertEq(pinned[0].isPinned, true, "AC-6.7c: isPinned = true");

  // 取消置顶
  im.pinMessage(msg1.id, false);
  const pinned2 = im.getPinnedMessages(conv.id);
  assertEq(pinned2.length, 0, "AC-6.7d: 取消后无置顶");

  // 验证 metadata 中不再有 isPinned（用独立列后）
  const msg = im.getMessage(msg1.id);
  assert(msg?.metadata.isPinned === undefined, "AC-6.7e: metadata 中无 isPinned（已迁移到独立列）");

  db.close();
}

// ─── 气泡拆分集成测试（通过 API 发送） ────────────────

function testBubbleSplitIntegration(): void {
  section("Bubble Split Integration (via sendMessage)");

  const db = createTestDb();
  const im = new ImService(db);

  const conv = im.createGroup({
    title: "气泡集成测试",
    ownerId: "user-a",
    members: [{ id: "user-a", type: "user", role: "owner" }],
  });

  // 模拟气泡拆分后发送
  const replyGroupId = "group-test-1";
  const parts = ["第一段：概述", "第二段：详情", "第三段：总结"];

  const messages = parts.map((part) =>
    im.sendMessage(conv.id, {
      senderId: "user-a", senderType: "user", role: "user",
      content: part,
      replyGroupId,
    })
  );

  // AC-6.8a: 3 条消息共享 replyGroupId
  assertEq(messages.length, 3, "AC-6.8a: 发送了 3 条消息");
  assert(messages.every((m) => m.replyGroupId === replyGroupId), "AC-6.8b: 全部共享 replyGroupId");

  // AC-6.8c: seq 连续
  const seqs = messages.map((m) => m.seq);
  assertEq(seqs[1], seqs[0] + 1, "AC-6.8c: seq 连续");
  assertEq(seqs[2], seqs[1] + 1, "AC-6.8d: seq 连续");

  // AC-6.8e: 查询时能看到 replyGroupId
  const history = im.getMessages(conv.id, { limit: 10 });
  assert(history.items.every((m) => m.replyGroupId === replyGroupId), "AC-6.8e: 查询结果带 replyGroupId");

  db.close();
}

// ─── 运行 ─────────────────────────────────────────────

console.log("════════════════════════════════════════════");
console.log("  Termany IM 阶段六测试");
console.log("════════════════════════════════════════════");

try { testBubbleSplit(); } catch (e) { console.error("BubbleSplit crashed:", e); failed++; }
try { testSidechains(); } catch (e) { console.error("Sidechains crashed:", e); failed++; }
try { testPinnedColumn(); } catch (e) { console.error("PinnedColumn crashed:", e); failed++; }
try { testBubbleSplitIntegration(); } catch (e) { console.error("BubbleSplitIntegration crashed:", e); failed++; }

console.log("\n════════════════════════════════════════════");
console.log(`  结果: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("  失败项:");
  failures.forEach((f) => console.log(`    ❌ ${f}`));
}
console.log("════════════════════════════════════════════");

process.exit(failed > 0 ? 1 : 0);
