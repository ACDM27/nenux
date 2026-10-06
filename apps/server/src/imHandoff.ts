/**
 * 跨 Agent 上下文接力 (Handoff) 服务
 *
 * 参考 Wake 的 handoff 管道设计：
 * parse → distill → render → inject
 *
 * 核心概念：
 * - UCS (Universal Context Snapshot): 4 层结构化摘要
 * - Distiller: 从完整对话中蒸馏出结构化摘要（Rules 模式 + LLM 预留）
 * - Renderer: 将快照渲染为目标格式（Markdown）
 * - Injector: 将渲染结果写入目标 Agent 项目目录
 *
 * UCS 4 层结构：
 * Layer 1: HandoffSummary — 关键决策 + 当前状态 + 下一步 (~500 tokens, 必传)
 * Layer 2: FileState — git diff 摘要 + 修改文件列表 (必传)
 * Layer 3: KeyExchanges — 精选 3-5 轮关键对话 (按需)
 * Layer 4: 用户备注 — 手写接力说明 (可选)
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ImService } from "./imService.js";

// ─── 数据结构 ─────────────────────────────────────────

export type DistillMode = "rules" | "llm";
export type TargetAgent = "codex" | "claude-code";

export interface HandoffSnapshot {
  version: string;
  snapshotId: string;
  source: HandoffSource;
  target: TargetAgent;
  summary: HandoffSummary;
  fileState: FileState;
  keyExchanges: KeyExchange[];
  handoffNote: string;
  createdAt: number;
}

export interface HandoffSource {
  agentId: string;
  conversationId: string;
  conversationTitle: string;
  projectPath: string;
  gitBranch: string | null;
  messagesTotal: number;
}

export interface HandoffSummary {
  /** AI 做出的关键决策 + 理由 */
  decisions: Decision[];
  /** 当前进行中的任务/卡点 */
  currentState: string;
  /** 下一步 TODO */
  nextSteps: string[];
  /** 重要的环境/约束信息 */
  contextNotes: string[];
}

export interface Decision {
  decision: string;
  rationale: string;
  madeAtSeq: number;
}

export interface FileState {
  uncommittedDiff: string | null;
  modifiedFiles: string[];
}

export interface KeyExchange {
  seqRange: [number, number];
  userMessage: string;
  assistantResponse: string;
  whyKey: string;
}

export interface HandoffResult {
  snapshot: HandoffSnapshot;
  renderedContent: string;
}

// ─── 蒸馏器 ───────────────────────────────────────────

/**
 * Rules 蒸馏器：从对话记录中提取结构化摘要
 * 纯规则抽取，离线可用，零成本
 */
function distillRules(messages: Array<{ seq: number; role: string; content: string }>): HandoffSummary {
  const decisions: Decision[] = [];
  let currentState = "";
  const nextSteps: string[] = [];
  const contextNotes: string[] = [];

  // 提取决策：含"决定"/"选择"/"use"/"decide"/"go with"的消息
  const decisionPatterns = [
    /(?:决定|选择|采用|使用|用)\s*(.+)/i,
    /(?:decided?|chose|chosen|use|go\s+with|will\s+use)\s+(.+)/i,
    /(?:我们|let'?s|we)\s+(?:用|use|go\s+with)\s+(.+)/i,
  ];

  // 提取下一步：含"接下来"/"下一步"/"TODO"/"need to"的消息
  const nextStepPatterns = [
    /(?:接下来|下一步)[：:]?\s*(.+)/i,
    /(?:然后|还需[要闻])[：:]\s*(.+)/i,
    /(?:TODO|FIXME|next\s+step|need\s+to)\s*[：:]?\s*(.+)/i,
  ];

  for (const msg of messages) {
    if (msg.role !== "assistant" && msg.role !== "user") continue;

    // 检查决策模式
    for (const pattern of decisionPatterns) {
      const match = msg.content.match(pattern);
      if (match) {
        decisions.push({
          decision: match[1]?.trim() || match[0],
          rationale: msg.content.slice(0, 200),
          madeAtSeq: msg.seq,
        });
        break;
      }
    }

    // 检查下一步模式
    for (const pattern of nextStepPatterns) {
      const match = msg.content.match(pattern);
      if (match) {
        nextSteps.push(match[1]?.trim() || match[0]);
        break;
      }
    }
  }

  // 当前状态：取最后一条 assistant 消息的摘要
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant) {
    currentState = lastAssistant.content.slice(0, 300);
  }

  // 上下文备注：提取含"注意"/"重要"/"constraint"的消息
  for (const msg of messages) {
    if (/(?:注意|重要|constraint|warning|caution)/i.test(msg.content)) {
      contextNotes.push(msg.content.slice(0, 200));
      if (contextNotes.length >= 5) break;
    }
  }

  return {
    decisions: decisions.slice(0, 10),
    currentState,
    nextSteps: nextSteps.slice(0, 5),
    contextNotes,
  };
}

/**
 * 从对话中提取关键交流片段
 * 评分规则（参考 Wake distiller.rs）：
 * - 有工具调用：+3
 * - 靠近末尾（近因）：+2 * recency
 * - 助手回复较长：+1
 * - 用户提问：+2
 */
function extractKeyExchanges(
  messages: Array<{ seq: number; role: string; content: string }>,
  maxCount = 5
): KeyExchange[] {
  // 收集 user→assistant 对
  const pairs: Array<{ seq: number; userMsg: string; assistantMsg: string; userSeq: number }> = [];
  let lastUser: { seq: number; content: string } | null = null;

  for (const m of messages) {
    if (m.role === "user") {
      lastUser = { seq: m.seq, content: m.content };
    } else if (m.role === "assistant" && lastUser) {
      pairs.push({
        seq: m.seq,
        userMsg: lastUser.content,
        assistantMsg: m.content,
        userSeq: lastUser.seq,
      });
      lastUser = null;
    }
  }

  const total = messages.length || 1;

  // 评分
  const scored = pairs.map((pair) => {
    let score = 0;

    // 有工具调用标记（```或代码块）
    if (pair.assistantMsg.includes("```") || pair.assistantMsg.includes("function")) {
      score += 3;
    }

    // 近因加权
    const recency = pair.seq / total;
    score += recency * 2;

    // 长回复
    if (pair.assistantMsg.length > 500) {
      score += 1;
    }

    // 用户提问
    if (pair.userMsg.includes("?") || pair.userMsg.includes("怎么") ||
        pair.userMsg.includes("如何") || pair.userMsg.includes("should") ||
        pair.userMsg.includes("which")) {
      score += 2;
    }

    return { score, pair };
  });

  // 按分数降序，取 top N
  scored.sort((a, b) => b.score - a.score);
  const topN = scored.slice(0, maxCount);

  // 按 seq 排序输出（保持对话顺序）
  topN.sort((a, b) => a.pair.userSeq - b.pair.userSeq);

  return topN.map(({ pair }) => ({
    seqRange: [pair.userSeq, pair.seq] as [number, number],
    userMessage: pair.userMsg.slice(0, 500),
    assistantResponse: pair.assistantMsg.slice(0, 800),
    whyKey: pair.assistantMsg.length > 500 ? "detailed technical discussion" : "key decision point",
  }));
}

// ─── 渲染器 ───────────────────────────────────────────

function renderMarkdown(snapshot: HandoffSnapshot): string {
  const lines: string[] = [];

  lines.push(`# Handoff: ${snapshot.source.conversationTitle || "Untitled Session"}`);
  lines.push("");
  lines.push(`> Source: **${snapshot.source.agentId}** in \`${snapshot.source.projectPath || "."}\``);
  if (snapshot.source.gitBranch) {
    lines.push(`> Branch: \`${snapshot.source.gitBranch}\``);
  }
  lines.push(`> Messages: ${snapshot.source.messagesTotal}`);
  lines.push(`> Snapshot: \`${snapshot.snapshotId}\``);
  lines.push("");

  // Layer 1: Summary
  lines.push("## Summary");
  lines.push("");

  if (snapshot.summary.currentState) {
    lines.push(`**Current State**: ${snapshot.summary.currentState}`);
    lines.push("");
  }

  if (snapshot.summary.decisions.length > 0) {
    lines.push("### Key Decisions");
    for (const d of snapshot.summary.decisions) {
      lines.push(`- **${d.decision}** (seq ${d.madeAtSeq})`);
      if (d.rationale) lines.push(`  - _${d.rationale.slice(0, 100)}_`);
    }
    lines.push("");
  }

  if (snapshot.summary.nextSteps.length > 0) {
    lines.push("### Next Steps");
    for (const step of snapshot.summary.nextSteps) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push("");
  }

  if (snapshot.summary.contextNotes.length > 0) {
    lines.push("### Context Notes");
    for (const note of snapshot.summary.contextNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  // Layer 2: File State
  if (snapshot.fileState.modifiedFiles.length > 0 || snapshot.fileState.uncommittedDiff) {
    lines.push("## File Changes");
    lines.push("");
    if (snapshot.fileState.modifiedFiles.length > 0) {
      lines.push("**Modified files:**");
      for (const f of snapshot.fileState.modifiedFiles) {
        lines.push(`- \`${f}\``);
      }
      lines.push("");
    }
    if (snapshot.fileState.uncommittedDiff) {
      lines.push("```diff");
      lines.push(snapshot.fileState.uncommittedDiff.slice(0, 2000));
      lines.push("```");
      lines.push("");
    }
  }

  // Layer 3: Key Exchanges
  if (snapshot.keyExchanges.length > 0) {
    lines.push("## Key Exchanges");
    lines.push("");
    for (const ke of snapshot.keyExchanges) {
      lines.push(`### seq ${ke.seqRange[0]}–${ke.seqRange[1]} (_${ke.whyKey}_)`);
      lines.push("");
      lines.push(`**User**: ${ke.userMessage.slice(0, 300)}`);
      lines.push("");
      lines.push(`**Assistant**: ${ke.assistantResponse.slice(0, 500)}`);
      lines.push("");
    }
  }

  // Layer 4: Handoff Note
  if (snapshot.handoffNote) {
    lines.push("## Handoff Note");
    lines.push("");
    lines.push(snapshot.handoffNote);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Handoff 服务 ──────────────────────────────────────

export class HandoffService {
  constructor(
    private db: DatabaseSync,
    private imService: ImService
  ) {}

  /** 从会话生成快照（不写入，用于预览） */
  prepareHandoff(
    conversationId: string,
    sourceAgentId: string,
    target: TargetAgent,
    options: { mode?: DistillMode; handoffNote?: string; projectPath?: string } = {}
  ): HandoffSnapshot {
    const conv = this.imService.getConversation(conversationId);
    if (!conv) throw new Error(`conversation ${conversationId} not found`);

    // 获取消息历史
    const { items: messages } = this.imService.getMessages(conversationId, { limit: 100 });
    const rawMessages = messages.map((m) => ({
      seq: m.seq,
      role: m.role,
      content: m.content,
    }));

    const mode = options.mode ?? "rules";
    const summary = mode === "rules"
      ? distillRules(rawMessages)
      : distillRules(rawMessages); // TODO: LLM mode

    const keyExchanges = extractKeyExchanges(rawMessages);

    return {
      version: "1.0",
      snapshotId: `snap_${Date.now()}_${randomUUID().slice(0, 4)}`,
      source: {
        agentId: sourceAgentId,
        conversationId,
        conversationTitle: conv.title,
        projectPath: options.projectPath ?? "",
        gitBranch: null, // TODO: 从 git 检测
        messagesTotal: conv.latestSeq,
      },
      target,
      summary,
      fileState: { uncommittedDiff: null, modifiedFiles: [] },
      keyExchanges,
      handoffNote: options.handoffNote ?? "",
      createdAt: Date.now(),
    };
  }

  /** 渲染预览 */
  renderPreview(snapshot: HandoffSnapshot): string {
    return renderMarkdown(snapshot);
  }

  /** 执行接力：生成快照 + 渲染 + 写入 DB */
  executeHandoff(snapshot: HandoffSnapshot): HandoffResult {
    const rendered = renderMarkdown(snapshot);

    // 写入 DB
    this.db.prepare(
      `INSERT INTO im_handoff
       (snapshot_id, source_conversation_id, source_agent_id, target_agent_id,
        project_path, distill_mode, snapshot_json, rendered_content, handoff_note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      snapshot.snapshotId,
      snapshot.source.conversationId,
      snapshot.source.agentId,
      snapshot.target,
      snapshot.source.projectPath,
      "rules",
      JSON.stringify(snapshot),
      rendered,
      snapshot.handoffNote,
      snapshot.createdAt
    );

    return { snapshot, renderedContent: rendered };
  }

  /** 列出接力记录 */
  listHandoffs(conversationId?: string, limit = 20): HandoffResult[] {
    const query = conversationId
      ? "SELECT * FROM im_handoff WHERE source_conversation_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM im_handoff ORDER BY created_at DESC LIMIT ?";

    const params = conversationId ? [conversationId, limit] : [limit];
    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((row) => ({
      snapshot: JSON.parse(row.snapshot_json),
      renderedContent: row.rendered_content,
    }));
  }
}
