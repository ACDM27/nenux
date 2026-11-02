/**
 * IM 模拟用户种子数据
 *
 * 创建 5 个测试用户 + DM/群组会话 + 各类测试消息。
 * 用法：tsx scripts/seed-im-users.ts [serverUrl]
 * 默认连接 http://localhost:5174
 */

const BASE = process.argv[2] ?? "http://localhost:5174";

// ─── 测试用户 ────────────────────────────────────────

const USERS = [
  { id: "alice",   name: "Alice（产品经理）" },
  { id: "bob",     name: "Bob（全栈开发）" },
  { id: "charlie", name: "Charlie（运维工程师）" },
  { id: "diana",   name: "Diana（设计师）" },
  { id: "eve",     name: "Eve（测试工程师）" },
];

// ─── 工具函数 ────────────────────────────────────────

let reqIdCounter = 0;
function reqId() {
  return `seed-${Date.now()}-${++reqIdCounter}`;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json() as { ok: boolean; data: T; error?: string };
  if (!json.ok) throw new Error(`API ${method} ${path} failed: ${json.error}`);
  return json.data;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 种子数据 ────────────────────────────────────────

async function seed() {
  console.log("🌱 Termany IM Seed — 创建模拟用户和测试对话...\n");

  // 1. 创建 DM 会话
  console.log("📩 创建 DM 会话...");
  const dmPairs: [string, string][] = [
    ["alice", "bob"],
    ["alice", "charlie"],
    ["bob", "charlie"],
    ["bob", "diana"],
    ["charlie", "eve"],
  ];

  const dmIds: Record<string, string> = {};
  for (const [a, b] of dmPairs) {
    const conv = await api<{ id: string }>("POST", "/api/im/conversations/dm", {
      userId: a,
      targetId: b,
    });
    dmIds[`${a}:${b}`] = conv.id;
    console.log(`  ✅ ${a} ↔ ${b} → ${conv.id.slice(0, 8)}...`);
  }

  // 2. 创建群组会话
  console.log("\n👥 创建群组会话...");

  const devGroup = await api<{ id: string }>("POST", "/api/im/conversations/group", {
    ownerId: "alice",
    title: "🚀 研发项目组",
    members: [
      { id: "alice", type: "user", role: "owner" },
      { id: "bob", type: "user" },
      { id: "charlie", type: "user" },
      { id: "diana", type: "user" },
      { id: "eve", type: "user" },
    ],
    clientRequestId: reqId(),
  });
  console.log(`  ✅ 研发项目组 → ${devGroup.id.slice(0, 8)}...`);

  const opsGroup = await api<{ id: string }>("POST", "/api/im/conversations/group", {
    ownerId: "charlie",
    title: "🔧 运维值班群",
    members: [
      { id: "charlie", type: "user", role: "owner" },
      { id: "bob", type: "user" },
      { id: "eve", type: "user" },
    ],
    clientRequestId: reqId(),
  });
  console.log(`  ✅ 运维值班群 → ${opsGroup.id.slice(0, 8)}...`);

  const designGroup = await api<{ id: string }>("POST", "/api/im/conversations/group", {
    ownerId: "diana",
    title: "🎨 设计评审",
    members: [
      { id: "diana", type: "user", role: "owner" },
      { id: "alice", type: "user" },
    ],
    clientRequestId: reqId(),
  });
  console.log(`  ✅ 设计评审 → ${designGroup.id.slice(0, 8)}...`);

  // 3. 发送测试消息
  console.log("\n💬 发送测试消息...");

  // -- 研发群组消息 --
  const devMessages = [
    { sender: "alice", content: "大家好！本周迭代目标已更新到飞书文档，请查看 📋" },
    { sender: "bob", content: "收到！API 重构的 PR 已经提了，@charlie 帮忙 review 一下部署脚本" },
    { sender: "charlie", content: "好的，我看一下。顺便说一句，服务器监控告警昨晚修好了 ✅" },
    { sender: "diana", content: "新版设计稿已上传 Figma，主要改了导航栏和消息列表的交互\nhttps://www.figma.com/file/abc123" },
    { sender: "eve", content: "测试用例已覆盖核心功能，发现 3 个 bug 已提 issue：\n- #142 消息发送偶发超时\n- #143 表情回应不刷新\n- #144 搜索中文分词不准" },
    { sender: "alice", content: "辛苦大家！周五下午 3 点开迭代回顾会 🙏" },
    { sender: "bob", content: "```typescript\nconst result = await imService.sendMessage({\n  conversationId: conv.id,\n  senderId: 'bob',\n  content: '这段代码在本地测试通过',\n});\nconsole.log('消息ID:', result.id);\n```" },
    { sender: "charlie", content: "提醒：今晚 10 点有服务器维护窗口，预计影响 30 分钟 🚧" },
  ];

  for (const msg of devMessages) {
    await api("POST", `/api/im/conversations/${devGroup.id}/messages`, {
      senderId: msg.sender,
      content: msg.content,
      clientRequestId: reqId(),
    });
    await sleep(50); // 模拟消息间隔
  }
  console.log(`  ✅ 研发项目组: ${devMessages.length} 条消息`);

  // -- 运维群消息 --
  const opsMessages = [
    { sender: "charlie", content: "📊 今日值班报告：\n- CPU 峰值 45%（14:00）\n- 内存使用 72%\n- 磁盘 63%\n- 无异常告警" },
    { sender: "bob", content: "coturn 的 TURN 中继流量正常吗？" },
    { sender: "charlie", content: "正常，峰值 200Mbps，在预期范围内" },
    { sender: "eve", content: "我跑的压力测试报告出来了，见附件 📎" },
    { sender: "bob", content: "收到，我看看数据" },
  ];

  for (const msg of opsMessages) {
    await api("POST", `/api/im/conversations/${opsGroup.id}/messages`, {
      senderId: msg.sender,
      content: msg.content,
      clientRequestId: reqId(),
    });
    await sleep(50);
  }
  console.log(`  ✅ 运维值班群: ${opsMessages.length} 条消息`);

  // -- DM 消息 (Alice ↔ Bob) --
  const dm1 = dmIds["alice:bob"];
  const aliceBobMsgs = [
    { sender: "alice", content: "Bob，ChatGPT OAuth 集成的方案你看了吗？" },
    { sender: "bob", content: "看了，参考了 TabTin 的实现。PKCE 流程已经跑通，模型选择用 gpt-5.6-sol" },
    { sender: "alice", content: "太好了！Codex API 的速率限制怎么样？" },
    { sender: "bob", content: "Plus 账户每 5 小时有限额，达到限制后等 57 分钟重置。Pro 账户额度更高" },
    { sender: "alice", content: "了解。那我们先按 Plus 额度做降级策略 👍" },
  ];

  for (const msg of aliceBobMsgs) {
    await api("POST", `/api/im/conversations/${dm1}/messages`, {
      senderId: msg.sender,
      content: msg.content,
      clientRequestId: reqId(),
    });
    await sleep(50);
  }
  console.log(`  ✅ Alice ↔ Bob: ${aliceBobMsgs.length} 条消息`);

  // -- DM 消息 (Bob ↔ Charlie) --
  const dm2 = dmIds["bob:charlie"];
  const bobCharlieMsgs = [
    { sender: "bob", content: "charlie，101.42.183.167 的磁盘快满了，能清理一下吗？" },
    { sender: "charlie", content: "我看看... 发现是 Docker 日志占了 15G，已经清理了 ✅" },
    { sender: "bob", content: "效率真高 👍" },
    { sender: "charlie", content: "顺便加了 log rotation，以后不会再爆了" },
  ];

  for (const msg of bobCharlieMsgs) {
    await api("POST", `/api/im/conversations/${dm2}/messages`, {
      senderId: msg.sender,
      content: msg.content,
      clientRequestId: reqId(),
    });
    await sleep(50);
  }
  console.log(`  ✅ Bob ↔ Charlie: ${bobCharlieMsgs.length} 条消息`);

  // 4. 部分已读标记
  console.log("\n👁️  设置已读/未读状态...");
  await api("POST", `/api/im/conversations/${devGroup.id}/read`, { userId: "alice" });
  await api("POST", `/api/im/conversations/${devGroup.id}/read`, { userId: "bob" });
  await api("POST", `/api/im/conversations/${opsGroup.id}/read`, { userId: "charlie" });
  console.log("  ✅ Alice/Bob 已读研发群，Charlie 已读运维群");

  // 5. 添加表情回应
  console.log("\n🎭 添加表情回应...");
  try {
    // 获取最新消息的 ID 来添加反应
    const msgs = await api<{ items: Array<{ id: number }> }>(
      "GET", `/api/im/conversations/${devGroup.id}/messages?limit=3`
    );
    if (msgs.items?.length > 0) {
      const lastMsgId = msgs.items[0].id;
      await api("POST", `/api/im/messages/${lastMsgId}/reactions`, {
        userId: "bob", emoji: "👍",
      });
      await api("POST", `/api/im/messages/${lastMsgId}/reactions`, {
        userId: "charlie", emoji: "❤️",
      });
      console.log(`  ✅ 最新消息添加了 👍 ❤️`);
    }
  } catch (e) {
    console.log("  ⚠️  表情回应添加失败（API 可能不支持直接调用）");
  }

  // 6. 置顶消息
  console.log("\n📌 置顶重要消息...");
  try {
    const msgs = await api<{ items: Array<{ id: number }> }>(
      "GET", `/api/im/conversations/${devGroup.id}/messages?limit=10`
    );
    if (msgs.items?.length > 2) {
      // 置顶 Alice 的第一条消息（迭代目标）
      const targetMsg = msgs.items[msgs.items.length - 1];
      await api("POST", `/api/im/messages/${targetMsg.id}/pin`, {
        userId: "alice",
      });
      console.log(`  ✅ 置顶了 Alice 的消息`);
    }
  } catch (e) {
    console.log("  ⚠️  置顶失败（API 可能不支持直接调用）");
  }

  console.log("\n🎉 种子数据创建完成！");
  console.log(`   用户: ${USERS.length} 个`);
  console.log(`   DM 会话: ${dmPairs.length} 个`);
  console.log(`   群组会话: 3 个`);
  console.log(`   消息: ${devMessages.length + opsMessages.length + aliceBobMsgs.length + bobCharlieMsgs.length} 条`);
  console.log("\n💡 提示: 使用不同 userId 调用 API 可模拟不同用户视角");
}

seed().catch((err) => {
  console.error("❌ 种子数据创建失败:", err);
  process.exit(1);
});
