# Termany IM 消息系统优化研发方案

> 参考：TabTin IM（企业级消息可靠性）+ Wake（跨 Agent 会话管理）
> 创建日期：2026-10-05
> 项目路径：`C:\Users\hk\Documents\projects\termany`

---

## 总体目标

将 Termany 的消息系统从"内存 JSON + WebSocket 即发即弃"升级为：
1. **持久化可靠投递**（参考 TabTin Outbox 模式）
2. **全文搜索 + 结构化查询**（参考 Wake FTS5）
3. **跨 Agent 上下文接力**（参考 Wake Handoff 管道）
4. **完整的 IM 交互语义**（已读/未读/编辑/撤回/置顶）

---

## 阶段一：消息持久化 + 序号体系（P0）

### 目标
把消息从 workspace JSON blob 迁移到独立的关系表，引入 `seq` 原子递增序号。

### 改动清单

| 文件 | 改动 |
|------|------|
| `apps/server/src/db.ts` | 新增 `im_conversation`, `im_message`, `im_conversation_member` 表 |
| `apps/server/src/db.ts` | 新增 `imConversationService` 模块（CRUD + seq 分配） |
| `apps/server/src/index.ts` | 新增 REST API 路由 `/api/im/*` |
| `packages/core/src/imTypes.ts` | 新增消息类型定义 |
| `packages/core/src/imClient.ts` | 新增客户端消息服务层 |

### 数据模型

```sql
CREATE TABLE IF NOT EXISTS im_conversation (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'dm',        -- dm | group
  title TEXT NOT NULL DEFAULT '',
  dm_hash TEXT UNIQUE,                     -- sha256(sorted([a,b])) DM去重
  latest_seq INTEGER NOT NULL DEFAULT 0,   -- 原子递增消息序号
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS im_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                    -- 会话内有序序号
  role TEXT NOT NULL DEFAULT 'user',       -- user | assistant | system
  sender_type TEXT NOT NULL DEFAULT 'user',-- user | agent | system
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT DEFAULT '{}',              -- JSON: files, reactions, mentions
  reply_to_seq INTEGER,                    -- 引用回复的目标 seq
  is_deleted INTEGER NOT NULL DEFAULT 0,   -- 软删除
  edited_at INTEGER,                       -- 编辑时间
  client_request_id TEXT UNIQUE,           -- 幂等去重
  search_text TEXT NOT NULL DEFAULT '',    -- 搜索聚合文本
  created_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (conversation_id) REFERENCES im_conversation(id)
);
CREATE INDEX IF NOT EXISTS idx_im_msg_conv_seq ON im_message(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_im_msg_conv_id ON im_message(conversation_id, id DESC);

CREATE TABLE IF NOT EXISTS im_conversation_member (
  conversation_id TEXT NOT NULL,
  user_or_bot_id TEXT NOT NULL,
  member_type TEXT NOT NULL DEFAULT 'user', -- user | bot
  role TEXT NOT NULL DEFAULT 'member',      -- owner | admin | member
  joined_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_or_bot_id)
);
```

### 验收标准

- [ ] **AC-1.1** 数据库迁移成功执行，三张新表创建无报错
- [ ] **AC-1.2** 创建 DM 会话：`POST /api/im/conversations/dm` 返回会话 ID，相同双方重复调用返回同一 ID（幂等）
- [ ] **AC-1.3** 创建群组会话：`POST /api/im/conversations/group` 支持添加多个 bot 成员
- [ ] **AC-1.4** 发送消息：`POST /api/im/conversations/:id/messages` 返回消息，`seq` 单调递增且无间隙
- [ ] **AC-1.5** 幂等发送：相同 `client_request_id` 第二次发送返回首次消息而非创建重复
- [ ] **AC-1.6** 获取历史：`GET /api/im/conversations/:id/messages?before_seq=N&limit=40` 返回按 seq 降序的消息列表
- [ ] **AC-1.7** 已有 workspace JSON 中的旧消息不受影响（向后兼容）
- [ ] **AC-1.8** 并发写入 100 条消息，seq 无重复无跳跃

---

## 阶段二：全文搜索 + Cursor 分页（P0）

### 目标
引入 FTS5 全文搜索索引，消息可搜索；分页从 offset 改为 cursor。

### 改动清单

| 文件 | 改动 |
|------|------|
| `apps/server/src/db.ts` | 新增 `im_message_fts` FTS5 虚拟表 |
| `apps/server/src/db.ts` | 消息写入时同步更新 FTS 索引 |
| `apps/server/src/index.ts` | 新增 `GET /api/im/search` 搜索 API |
| `apps/server/src/index.ts` | 消息历史 API 改用 cursor 分页 |

### 数据模型

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS im_message_fts USING fts5(
  conversation_id, content, search_text,
  content='im_message', content_rowid='id',
  tokenize='unicode61'
);

-- 触发器：消息插入/更新/删除时同步 FTS
CREATE TRIGGER IF NOT EXISTS im_msg_fts_insert AFTER INSERT ON im_message BEGIN
  INSERT INTO im_message_fts(rowid, conversation_id, content, search_text)
  VALUES (new.id, new.conversation_id, new.content, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS im_msg_fts_delete AFTER DELETE ON im_message BEGIN
  INSERT INTO im_message_fts(im_message_fts, rowid, conversation_id, content, search_text)
  VALUES ('delete', old.id, old.conversation_id, old.content, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS im_msg_fts_update AFTER UPDATE ON im_message BEGIN
  INSERT INTO im_message_fts(im_message_fts, rowid, conversation_id, content, search_text)
  VALUES ('delete', old.id, old.conversation_id, old.content, old.search_text);
  INSERT INTO im_message_fts(rowid, conversation_id, content, search_text)
  VALUES (new.id, new.conversation_id, new.content, new.search_text);
END;
```

### 验收标准

- [ ] **AC-2.1** 搜索 API：`GET /api/im/search?q=关键词` 返回匹配消息，高亮命中词
- [ ] **AC-2.2** 中文搜索：输入"服务器"能匹配包含该词的消息
- [ ] **AC-2.3** 英文搜索：输入"error"能匹配包含该词的消息（不区分大小写）
- [ ] **AC-2.4** 搜索范围：支持 `conversation_id` 参数限定搜索范围
- [ ] **AC-2.5** Cursor 分页：`GET /api/im/conversations/:id/messages?before=N&limit=40` 返回消息 + `next_cursor`
- [ ] **AC-2.6** 搜索性能：10000 条消息中搜索 < 50ms
- [ ] **AC-2.7** 搜索结果按相关度排序，返回会话 + seq + 上下文预览

---

## 阶段三：已读/未读 + 消息编辑/撤回（P1）

### 目标
实现已读水位线、未读计数、消息编辑和撤回功能。

### 改动清单

| 文件 | 改动 |
|------|------|
| `apps/server/src/db.ts` | 新增 `im_conversation_state` 表（已读水位/静音/置顶） |
| `apps/server/src/db.ts` | 新增 `im_reaction` 表（表情回应） |
| `apps/server/src/index.ts` | 新增已读标记/未读计数/编辑/撤回/置顶 API |
| `apps/server/src/index.ts` | WebSocket 广播 IM 事件 |

### 数据模型

```sql
CREATE TABLE IF NOT EXISTS im_conversation_state (
  conversation_id TEXT NOT NULL,
  user_or_bot_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  history_cleared_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_or_bot_id)
);

CREATE TABLE IF NOT EXISTS im_reaction (
  message_id INTEGER NOT NULL,
  user_or_bot_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, user_or_bot_id, emoji),
  FOREIGN KEY (message_id) REFERENCES im_message(id)
);
```

### API 清单

```
POST /api/im/conversations/:id/read          → 标记已读（推进水位）
GET  /api/im/unread-counts                    → 获取各会话未读数
PUT  /api/im/messages/:id                     → 编辑消息
DELETE /api/im/messages/:id                    → 撤回消息（2分钟内）
POST /api/im/messages/:id/pin                 → 置顶/取消置顶
POST /api/im/messages/:id/reactions           → 添加/移除表情回应
POST /api/im/conversations/:id/pin            → 置顶/取消置顶会话
POST /api/im/conversations/:id/mute           → 静音/取消静音会话
```

### 验收标准

- [ ] **AC-3.1** 标记已读：`POST /api/im/conversations/:id/read` 推进 `last_read_seq`
- [ ] **AC-3.2** 未读计数：`GET /api/im/unread-counts` 返回每个会话的未读消息数
- [ ] **AC-3.3** 未读规则：`seq > last_read_seq` 且 `seq > history_cleared_seq` 且非自己发送
- [ ] **AC-3.4** 消息编辑：`PUT /api/im/messages/:id` 修改内容，`edited_at` 标记，搜索索引更新
- [ ] **AC-3.5** 消息撤回：`DELETE /api/im/messages/:id` 仅发送者、2 分钟内，软删除
- [ ] **AC-3.6** 撤回后预览更新：最新消息被撤回后会话预览变为"消息已撤回"
- [ ] **AC-3.7** 表情回应：添加 👀 / 👍 / ❤️ 等，同一用户同一 emoji 唯一
- [ ] **AC-3.8** WebSocket 广播：编辑/撤回/已读/表情变更实时推送到客户端
- [ ] **AC-3.9** 会话置顶/静音：状态持久化，列表按置顶优先排序

---

## 阶段四：事件可靠投递 Outbox（P1）

### 目标
实现 Outbox 模式保证消息事件不丢失。

### 改动清单

| 文件 | 改动 |
|------|------|
| `apps/server/src/db.ts` | 新增 `im_event_outbox` 表 |
| `apps/server/src/imOutbox.ts` | 新增 Outbox Worker（claim → deliver → 重试） |
| `apps/server/src/index.ts` | 发消息事务内写 outbox |
| `apps/server/src/imEvents.ts` | 新增事件类型定义 |

### 数据模型

```sql
CREATE TABLE IF NOT EXISTS im_event_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,            -- conversation:{id} | personal:{userId}
  event_type TEXT NOT NULL,         -- message | deleted | edited | read | reaction ...
  payload TEXT NOT NULL,            -- JSON
  status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | retry | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON im_event_outbox(status, created_at);
```

### 投递流程

```
消息发送（事务内）
  ├── 写 im_message
  ├── 写 im_event_outbox (status=pending)
  └── COMMIT
        ↓
Outbox Worker（每 500ms 轮询）
  ├── claim: SELECT ... WHERE status='pending' LIMIT 10 FOR UPDATE SKIP LOCKED
  ├── 投递: 通过 WebSocket 广播到对应 channel
  ├── 成功: status=delivered
  └── 失败: attempts++, 指数退避 (min(300, 2^attempts)s), 最多 8 次后 dead
```

### 验收标准

- [ ] **AC-4.1** 消息发送后 outbox 中出现 PENDING 记录
- [ ] **AC-4.2** Worker 在 1 秒内将 PENDING 变为 DELIVERED
- [ ] **AC-4.3** WebSocket 断连时，事件保持 PENDING/RETRY，重连后重投
- [ ] **AC-4.4** 指数退避：第 1 次 2s，第 2 次 4s，第 3 次 8s ... 上限 300s
- [ ] **AC-4.5** 8 次失败后标记 DEAD，不再自动重试
- [ ] **AC-4.6** 幂等投递：相同 event_id 不会重复广播
- [ ] **AC-4.7** 租约机制：claim 后 30s 未完成自动释放

---

## 阶段五：跨 Agent 上下文接力 Handoff（P1）

### 目标
移植 Wake 的 Handoff 管道到 Termany，支持 Agent 间上下文传递。

### 改动清单

| 文件 | 改动 |
|------|------|
| `apps/server/src/db.ts` | 新增 `im_handoff` 表 |
| `apps/server/src/imHandoff.ts` | 新增 Handoff 管道（蒸馏 → 渲染 → 注入） |
| `apps/server/src/imHandoff.ts` | 新增 UCS 数据结构 |
| `apps/server/src/imHandoff.ts` | 新增 Rules 蒸馏器 |
| `apps/server/src/index.ts` | 新增 Handoff API |

### 数据模型

```sql
CREATE TABLE IF NOT EXISTS im_handoff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT NOT NULL UNIQUE,
  source_conversation_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  project_path TEXT NOT NULL DEFAULT '',
  distill_mode TEXT NOT NULL DEFAULT 'rules',  -- rules | llm
  snapshot_json TEXT NOT NULL,
  rendered_content TEXT NOT NULL,
  handoff_note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | delivered | failed
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_handoff_conv ON im_handoff(source_conversation_id);
```

### UCS 4 层结构

```
Layer 1: HandoffSummary   — 关键决策 + 当前状态 + 下一步 (~500 tokens, 必传)
Layer 2: FileState        — git diff 摘要 + 修改文件列表 (必传)
Layer 3: KeyExchanges     — 精选 3-5 轮关键对话 (按需)
Layer 4: 用户备注          — 手写接力说明 (可选)
```

### 验收标准

- [ ] **AC-5.1** 创建接力：`POST /api/im/handoffs` 从源会话生成 UCS 快照
- [ ] **AC-5.2** Rules 蒸馏：自动提取决策、当前状态、下一步
- [ ] **AC-5.3** 关键对话选择：按评分（工具调用+3、近因+2、长度+1、疑问+2）选 top 3-5
- [ ] **AC-5.4** 渲染输出：生成 Markdown 格式的接力文档
- [ ] **AC-5.5** 预览：`GET /api/im/handoffs/preview` 返回渲染结果但不写入
- [ ] **AC-5.6** 执行：`POST /api/im/handoffs/:id/execute` 写入目标 Agent 项目目录
- [ ] **AC-5.7** 接力历史：`GET /api/im/handoffs` 列出所有接力记录
- [ ] **AC-5.8** WebSocket 广播 `handoff.update` 事件到相关会话

---

## 阶段六：消息气泡拆分 + 侧链 + 富媒体增强（P2）

### 目标
实现消息气泡拆分、侧链消息、消息置顶等增强功能。

### 改动清单

| 文件 | 改动 |
|------|------|
| `apps/server/src/db.ts` | message 加 `sidechain_id`, `reply_group_id` 字段 |
| `apps/server/src/imBubbleSplit.ts` | 新增气泡拆分算法 |
| `apps/server/src/index.ts` | 新增侧链 API |

### 验收标准

- [ ] **AC-6.1** 气泡拆分：模型一次回复按 `<!-- message_break -->` 或自然边界拆成多条气泡
- [ ] **AC-6.2** 代码块完整：拆分不切断 ``` 代码块和表格
- [ ] **AC-6.3** reply_group_id：拆分出的气泡共享同一 group ID
- [ ] **AC-6.4** 侧链创建：`POST /api/im/conversations/:id/sidechains` 创建侧链
- [ ] **AC-6.5** 侧链消息：侧链内独立 seq 空间
- [ ] **AC-6.6** 消息置顶：`is_pinned` 标记，`GET /api/im/conversations/:id/pinned` 列出

---

## 阶段七：WebSocket 事件广播 + 客户端集成（P2）

### 目标
前端接入全部 IM 事件，实现实时消息推送、未读更新、输入状态等。

### 事件类型清单

```
im.message              — 新消息
im.message.deleted      — 消息撤回
im.message.edited       — 消息编辑
im.message.pinned       — 消息置顶
im.member.joined        — 成员加入
im.member.left          — 成员离开
im.unread.update        — 未读数更新
im.read.receipt         — 已读回执
im.reaction.added       — 表情反应
im.reaction.removed     — 取消反应
im.typing               — 正在输入
im.handoff.update       — 接力包更新
im.conversation.updated — 会话更新
```

### 验收标准

- [ ] **AC-7.1** 客户端连接 WebSocket 后收到所有订阅会话的实时事件
- [ ] **AC-7.2** 新消息事件触发 Inbox 未读计数更新
- [ ] **AC-7.3** 编辑/撤回事件更新本地消息列表
- [ ] **AC-7.4** 输入状态广播：一方输入时对方看到"正在输入..."
- [ ] **AC-7.5** 断线重连后自动同步缺失事件（基于 last_read_seq）

---

## 执行节奏

| 周次 | 阶段 | 核心交付 | 预估工时 |
|------|------|---------|---------|
| Week 1 Day 1-2 | 阶段一 | 数据模型 + 迁移 + 基础 CRUD API | 2d |
| Week 1 Day 3-4 | 阶段二 | FTS5 搜索 + Cursor 分页 | 2d |
| Week 2 Day 1-2 | 阶段三 | 已读/未读 + 编辑/撤回 | 2d |
| Week 2 Day 3-4 | 阶段四 | Outbox 可靠投递 | 2d |
| Week 3 Day 1-3 | 阶段五 | Handoff 跨 Agent 接力 | 3d |
| Week 3 Day 4-5 | 阶段六 | 气泡拆分 + 侧链 | 2d |
| Week 4 Day 1-2 | 阶段七 | WebSocket 事件 + 客户端集成 | 2d |

---

## 风险与约束

1. **node:sqlite 限制**：Node.js 内置 SQLite 不支持 `FOR UPDATE SKIP LOCKED`，Outbox 需用 JS 层锁模拟
2. **FTS5 中文分词**：`unicode61` tokenizer 对中文按字拆分，精度有限；后续可换 `jieba` 或 `trigram`
3. **向后兼容**：workspace JSON 中的旧消息系统保留，新 IM 系统并行运行
4. **性能**：SQLite 单写者限制，高并发场景需要 WAL + 写入队列
