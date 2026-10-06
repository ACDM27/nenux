/**
 * 阶段七测试：WebSocket 事件广播 + 订阅管理
 *
 * 运行: node --import tsx apps/server/src/imPhase7.test.ts
 */

import {
  createSubscriptionManager,
  registerConnection,
  unregisterConnection,
  subscribe,
  unsubscribe,
  broadcastToChannel,
  handleClientMessage,
  createOutboxDeliver,
} from "./imEvents.js";

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

// Mock WebSocket (readyState=1 = OPEN)
class MockWebSocket {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
}

// ─── 订阅管理测试 ───────────────────────────────────────

function testSubscriptions(): void {
  section("Subscription Manager");

  const subs = createSubscriptionManager();
  const wsA = new MockWebSocket() as unknown as import("ws").WebSocket;
  const wsB = new MockWebSocket() as unknown as import("ws").WebSocket;

  // AC-7.1: 注册连接自动订阅 personal channel
  registerConnection(subs, "0", "user-a", wsA);
  assert(subs.subscriptions.has("0"), "AC-7.1a: 连接已注册");
  assert(subs.subscriptions.get("0")!.has("personal:user-a"), "AC-7.1b: 自动订阅 personal:user-a");
  assertEq(subs.userIds.get("0"), "user-a", "AC-7.1c: userId 已记录");

  // AC-7.2: 手动订阅 conversation channel
  subscribe(subs, "0", "conversation:conv-1");
  assert(subs.subscriptions.get("0")!.has("conversation:conv-1"), "AC-7.2: 手动订阅成功");

  // AC-7.3: 取消订阅
  unsubscribe(subs, "0", "conversation:conv-1");
  assert(!subs.subscriptions.get("0")!.has("conversation:conv-1"), "AC-7.3: 取消订阅成功");

  // 注册第二个连接
  registerConnection(subs, "1", "user-b", wsB);
  subscribe(subs, "1", "conversation:conv-1");

  // AC-7.4: 广播只到订阅者
  const delivered = broadcastToChannel(
    subs,
    "conversation:conv-1",
    "im.message",
    { content: "hello" }
  );
  assertEq(delivered, 1, "AC-7.4a: 只有 user-b 收到（user-a 已取消订阅）");

  // AC-7.5: personal channel 广播
  const delivered2 = broadcastToChannel(
    subs,
    "personal:user-a",
    "im.unread.update",
    { count: 5 }
  );
  assertEq(delivered2, 1, "AC-7.5: personal:user-a 投递成功");

  // AC-7.6: 注销连接
  unregisterConnection(subs, "0");
  assert(!subs.subscriptions.has("0"), "AC-7.6a: 连接已移除");
  assert(!subs.userIds.has("0"), "AC-7.6b: userId 已清除");
}

// ─── 客户端消息处理测试 ─────────────────────────────────

function testClientMessages(): void {
  section("Client Message Handling");

  const subs = createSubscriptionManager();
  const wsA = new MockWebSocket() as unknown as import("ws").WebSocket;
  const wsB = new MockWebSocket() as unknown as import("ws").WebSocket;

  registerConnection(subs, "0", "user-a", wsA);
  registerConnection(subs, "1", "user-b", wsB);

  // AC-7.7: subscribe 消息
  handleClientMessage(
    subs,
    "0",
    JSON.stringify({ type: "subscribe", channel: "conversation:conv-x" })
  );
  assert(subs.subscriptions.get("0")!.has("conversation:conv-x"), "AC-7.7: subscribe 消息处理成功");

  // AC-7.8: 鉴权 — 不能订阅别人的 personal channel
  handleClientMessage(
    subs,
    "0",
    JSON.stringify({ type: "subscribe", channel: "personal:user-b" })
  );
  assert(!subs.subscriptions.get("0")!.has("personal:user-b"), "AC-7.8: 不能订阅别人的 personal channel");

  // AC-7.9: typing 事件转发
  handleClientMessage(
    subs,
    "0",
    JSON.stringify({ type: "subscribe", channel: "conversation:conv-y" })
  );
  subscribe(subs, "1", "conversation:conv-y");

  // 发送 typing，user-b 应该收到
  handleClientMessage(
    subs,
    "0",
    JSON.stringify({ type: "typing", channel: "conversation:conv-y" })
  );
  const typingEvents = wsB.sent.filter((s) => JSON.parse(s).type === "im.typing");
  assert(typingEvents.length >= 1, `AC-7.9: typing 事件已转发 (${typingEvents.length} 次)`);

  // AC-7.10: 非法 JSON 不崩溃
  handleClientMessage(
    subs,
    "0",
    "not json at all"
  );
  assert(true, "AC-7.10: 非法 JSON 不崩溃");
}

// ─── Outbox deliver 回调测试 ───────────────────────────

function testOutboxDeliver(): void {
  section("Outbox Deliver Callback");

  const subs = createSubscriptionManager();
  const ws = new MockWebSocket() as unknown as import("ws").WebSocket;

  registerConnection(subs, "0", "user-a", ws);
  subscribe(subs, "0", "conversation:test-conv");

  const deliver = createOutboxDeliver(subs);

  // AC-7.11: deliver 回调正确广播
  deliver("conversation:test-conv", "im.message", JSON.stringify({ seq: 1, content: "hi" })).then(() => {
    const events = ws.sent.filter((s) => {
      const parsed = JSON.parse(s);
      return parsed.type === "im.message" && parsed.channel === "conversation:test-conv";
    });
    assert(events.length >= 1, `AC-7.11: deliver 回调广播成功 (${events.length} 次)`);
  });

  // AC-7.12: 非 JSON payload 也能处理
  deliver("conversation:test-conv", "im.typing", "plain text payload").then(() => {
    assert(true, "AC-7.12: 非 JSON payload 不崩溃");
  });
}

// ─── 运行 ─────────────────────────────────────────────

console.log("════════════════════════════════════════════");
console.log("  Termany IM 阶段七测试");
console.log("════════════════════════════════════════════");

try { testSubscriptions(); } catch (e) { console.error("Subscriptions crashed:", e); failed++; }
try { testClientMessages(); } catch (e) { console.error("ClientMessages crashed:", e); failed++; }
try { testOutboxDeliver(); } catch (e) { console.error("OutboxDeliver crashed:", e); failed++; }

// 等异步 deliver 完成
setTimeout(() => {
  console.log("\n════════════════════════════════════════════");
  console.log(`  结果: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("  失败项:");
    failures.forEach((f) => console.log(`    ❌ ${f}`));
  }
  console.log("════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}, 100);
