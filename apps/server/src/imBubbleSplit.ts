/**
 * 消息气泡拆分算法
 *
 * 模型一次回复可能被拆分成多条聊天气泡（最多 4 条），
 * 模拟真实 IM 的"连续发消息"体验。
 *
 * 拆分规则：
 * 1. 显式分隔符：<!-- message_break -->
 * 2. 隐式分隔：段落间的空行 + 长度阈值（>300 字符考虑拆分）
 * 3. 不切断：代码块 (```)、表格、列表
 * 4. 最多拆成 4 条，每条至少 50 字符
 *
 * 拆分后的气泡共享 replyGroupId，seq 连续分配。
 *
 * 参考 Termany 前端的 splitAgentReply（apps/web/src/agentMessages.ts）
 */

/** 显式气泡分隔标记 */
export const MESSAGE_BREAK = "<!-- message_break -->";

/** 拆分结果 */
export interface BubbleSplit {
  /** 拆分后的各段内容 */
  parts: string[];
  /** 共享的 replyGroupId */
  replyGroupId: string;
}

/** 拆分配置 */
export interface SplitOptions {
  /** 最大拆分数，默认 4 */
  maxBubbles?: number;
  /** 最小气泡字符数，默认 50 */
  minChars?: number;
  /** 共享的 replyGroupId（由调用方生成） */
  replyGroupId?: string;
}

/**
 * 将一条长消息拆分为多个气泡
 */
export function splitIntoBubbles(
  content: string,
  options: SplitOptions = {}
): BubbleSplit {
  const maxBubbles = options.maxBubbles ?? 4;
  const minChars = options.minChars ?? 50;
  const replyGroupId = options.replyGroupId ?? crypto.randomUUID();

  // 先按显式分隔符拆分
  if (content.includes(MESSAGE_BREAK)) {
    const parts = content
      .split(MESSAGE_BREAK)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .slice(0, maxBubbles);

    return { parts, replyGroupId };
  }

  // 没有显式分隔符 → 尝试智能拆分
  // 策略：按双换行（段落边界）拆分，合并过短的段，切断过长的段

  const paragraphs = content.split(/\n\n+/);

  if (paragraphs.length <= 1) {
    // 单段不拆
    return { parts: [content.trim()], replyGroupId };
  }

  // 检查是否包含代码块或表格（不切断）
  const hasCodeBlocks = content.includes("```");
  const hasTables = /\|.*\|.*\|\n\|[-:|]+\|/.test(content);

  if (hasCodeBlocks || hasTables) {
    // 有代码块或表格时，只在代码块/表格外拆分
    return smartSplitAroundBlocks(content, maxBubbles, minChars, replyGroupId);
  }

  // 纯文本：按段落拆分，合并过短段
  const merged = mergeShortParagraphs(paragraphs, minChars);

  if (merged.length <= 1) {
    return { parts: [content.trim()], replyGroupId };
  }

  // 限制最大气泡数
  const parts = merged.slice(0, maxBubbles);

  // 如果还有剩余段落，拼到最后一个气泡
  if (merged.length > maxBubbles) {
    const tail = merged.slice(maxBubbles).join("\n\n");
    parts[parts.length - 1] = parts[parts.length - 1] + "\n\n" + tail;
  }

  return {
    parts: parts.map((p) => p.trim()).filter((p) => p.length > 0),
    replyGroupId,
  };
}

/**
 * 合并过短的段落
 * 如果连续段落 < minChars，合并到前一个
 */
function mergeShortParagraphs(paragraphs: string[], minChars: number): string[] {
  const result: string[] = [];

  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (trimmed.length === 0) continue;

    if (result.length === 0) {
      result.push(trimmed);
    } else if (result[result.length - 1].length < minChars) {
      // 前一段太短，合并
      result[result.length - 1] += "\n\n" + trimmed;
    } else {
      result.push(trimmed);
    }
  }

  return result;
}

/**
 * 在代码块/表格外部进行智能拆分
 * 找到代码块/表格的边界，只在外部拆分
 */
function smartSplitAroundBlocks(
  content: string,
  maxBubbles: number,
  minChars: number,
  replyGroupId: string
): BubbleSplit {
  // 找到所有代码块的边界
  const blocks: Array<{ start: number; end: number }> = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    blocks.push({ start: match.index, end: match.index + match[0].length });
  }

  // 找到所有表格的边界
  const tableRegex = /(\|[^\n]+\|\n)+\|[-:| ]+\|(\n\|[^\n]+\|)+/g;
  while ((match = tableRegex.exec(content)) !== null) {
    blocks.push({ start: match.index, end: match.index + match[0].length });
  }

  // 按 start 排序
  blocks.sort((a, b) => a.start - b.start);

  // 在 blocks 之间的区域找拆分点（双换行）
  const splitPoints: number[] = [];
  const breakRegex = /\n\n+/g;

  while ((match = breakRegex.exec(content)) !== null) {
    const pos = match.index;
    // 检查这个位置是否在任何 block 内部
    const insideBlock = blocks.some(
      (b) => pos >= b.start && pos < b.end
    );
    if (!insideBlock) {
      splitPoints.push(pos);
    }
  }

  if (splitPoints.length === 0) {
    return { parts: [content.trim()], replyGroupId };
  }

  // 选择最佳的拆分点（尽量均匀，且每段 >= minChars）
  const totalLen = content.length;
  const idealChunkLen = totalLen / Math.min(maxBubbles, splitPoints.length + 1);

  const selectedPoints: number[] = [];
  for (const sp of splitPoints) {
    if (selectedPoints.length >= maxBubbles - 1) break;
    // 距上一个拆分点至少 minChars
    const lastPoint = selectedPoints.length > 0
      ? selectedPoints[selectedPoints.length - 1]
      : 0;
    if (sp - lastPoint >= minChars && totalLen - sp >= minChars) {
      selectedPoints.push(sp);
    }
  }

  if (selectedPoints.length === 0) {
    return { parts: [content.trim()], replyGroupId };
  }

  // 按拆分点切分
  const parts: string[] = [];
  let start = 0;
  for (const sp of selectedPoints) {
    parts.push(content.slice(start, sp).trim());
    start = sp;
  }
  parts.push(content.slice(start).trim());

  return {
    parts: parts.filter((p) => p.length > 0),
    replyGroupId,
  };
}
