import type { Citation, MemoryEntry, Message } from '@aurevoy/shared';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getProvider } from '../llm/provider.js';
import { getEmbeddingProvider } from '../embedding/provider.js';
import { searchMemoryVec, isVecLoaded, getMemorySummary, setMemorySummary } from '../store/db.js';
import { skillRegistry } from '../skills/registry.js';

/**
 * 构建可用 skill 的 catalog 消息（Tier 1: name + description + location），
 * 注入到 system prompt 中，让模型知道技能（skill）的存在，可通过 load_skill 工具加载。
 * 当无可用 skill 时返回 null（标准要求不展示空 catalog）。
 */
export function buildSkillCatalogMessage(): Message | null {
  const all = skillRegistry.listAll();
  const descriptors = all.filter((s) => s.enabled);
  if (descriptors.length === 0) return null;

  const catalogLines = descriptors.map((s) => {
    return `- **${s.name}**: ${s.description}`;
  }).join('\n');

  const content =
    '<available_skills>\n' +
    'The following skills provide specialized instructions for specific tasks.\n' +
    'When a task matches a skill\'s description, call the load_skill tool\n' +
    'with the skill\'s name to load its instructions.\n\n' +
    catalogLines +
    '\n</available_skills>';

  return {
    id: randomUUID(),
    role: 'system',
    content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Cache-aware 上下文压缩管线（参考 Claude Code 四层压缩设计）。
 *
 * 三层递进压缩（由轻到重）：
 *   1. Snip（零成本） → 2. Microcompact（零成本） → 3. Context Collapse（LLM 摘要）
 *
 * Cache-aware：
 *   - Snip 和 Microcompact 只作用于 cachedUpTo 之后的新消息，不破坏 prompt cache
 *   - Context Collapse 修改旧消息 → 返回 collapsed=true，调用方重置缓存边界
 *   - Read/Write/Edit 工具结果不压缩：截断会导致 LLM 重读，得不偿失
 */

// ---- 工具类型分类 ----

/** 输出较大的工具（内容会被 Microcompact 结构化压缩） */
const TOOLS_WITH_LARGE_OUTPUT = new Set([
  'open_file', 'scroll', 'search_grep', 'web_fetch', 'web_search',
  'execute_command', 'edit_lines', 'replace_lines',
]);

/** 写入/确认类工具（输出简短，不压缩） */
const TOOLS_KEEP_VERBATIM = new Set([
  'write_file', 'create_file', 'append_file', 'copy_file', 'move_file', 'rename_file',
  'delete_file', 'session_open', 'session_write', 'session_close', 'session_abort',
  'apply_artifact', 'create_artifact', 'remember', 'index_files', 'recall',
]);

// ---- 公共类型 ----

export interface CompactContextResult {
  /** 压缩后的消息列表 */
  messages: Message[];
  /** Context Collapse 是否执行了（true → 调用方应重置缓存边界） */
  collapsed: boolean;
  stats: {
    snipped: number;
    microcompacted: number;
    cachedPrefixPreserved: boolean;
    savedTokens: number;
    originalTokens: number;
    finalTokens: number;
  };
}

// ---- 1. Snip: 移除空/无意义的 tool_result ----

/**
 * 移除空的 tool_result 消息及其配对的 assistant（如果该 assistant 的所有工具结果都被移除）。
 * 只操作 cachedUpTo 之后的消息，不破坏 prompt cache 前缀。
 */
function snipToolResults(messages: Message[], cachedUpTo: number): Message[] {
  // 构建 toolCallId → toolName 映射
  const toolCallToName = buildToolNameMap(messages);

  // 找出可以 snip 的 tool_result index
  const snipToolResultIndices = new Set<number>();
  for (let i = cachedUpTo; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || !m.toolCallId) continue;

    // 检查内容是否为空或仅含基本信息
    const toolName = toolCallToName.get(m.toolCallId);
    if (toolName && TOOLS_KEEP_VERBATIM.has(toolName)) continue; // 保留确认类结果

    const content = m.content?.trim();
    if (!content || content === '{}' || content === '{"ok":true}' || content === 'null' || content === 'undefined') {
      snipToolResultIndices.add(i);
    }
  }

  if (snipToolResultIndices.size === 0) return messages;

  // 同时检查配对的 assistant：如果它的所有 tool_results 都被 snip 了，也移除该 assistant
  const snipAssistantIndices = new Set<number>();
  for (let i = cachedUpTo; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;

    const callIds = new Set(m.toolCalls.map(tc => tc.id));
    let allSnipped = true;
    let anyFound = false;
    // 向后扫描配对的 tool 结果
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
      const tm = messages[j];
      if (tm.toolCallId && callIds.has(tm.toolCallId)) {
        anyFound = true;
        if (!snipToolResultIndices.has(j)) {
          allSnipped = false;
          break;
        }
      }
    }
    if (anyFound && allSnipped) {
      snipAssistantIndices.add(i);
    }
  }

  const remove = new Set([...snipToolResultIndices, ...snipAssistantIndices]);
  return messages.filter((_, i) => !remove.has(i));
}

// ---- 2. Microcompact: 结构化工具结果压缩 ----

/** 构建 toolCallId → toolName 映射 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}

/** 按工具类型对单个 tool_result 的 content 做结构化压缩。返回 null = 不需要压缩。 */
function compactToolResult(toolName: string, rawContent: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }

  switch (toolName) {
    case 'open_file':
    case 'scroll': {
      const path = parsed.path as string | undefined;
      const totalLines = parsed.total_lines as number | undefined;
      const winStart = parsed.window_start as number | undefined;
      const winEnd = parsed.window_end as number | undefined;
      const center = parsed.center_line as number | undefined;
      return JSON.stringify({
        path,
        total_lines: totalLines,
        window_start: winStart,
        window_end: winEnd,
        center_line: center,
        _compacted: true,
        _note: `视口 ${winStart}-${winEnd}/${totalLines}，中心行 ${center}`,
      });
    }

    case 'search_grep': {
      const pattern = parsed.pattern as string | undefined;
      const count = parsed.match_count as number | undefined;
      const matches = Array.isArray(parsed.matches) ? parsed.matches as Record<string, unknown>[] : [];
      return JSON.stringify({
        pattern,
        match_count: count,
        truncated: parsed.truncated,
        matches: matches.slice(0, 3).map(m => ({
          file: m.file,
          line: m.line,
          content: String(m.content ?? '').slice(0, 200),
        })),
        _compacted: true,
        _note: count && count > 3
          ? `前 3/${count} 条匹配。用更精确的 pattern 缩小范围。`
          : undefined,
      });
    }

    case 'web_fetch': {
      const url = parsed.url as string | undefined;
      const status = parsed.status as number | undefined;
      const text = (parsed.content as string | undefined) ?? '';
      const links = Array.isArray(parsed.links) ? parsed.links as Record<string, unknown>[] : [];
      return JSON.stringify({
        url,
        status,
        contentType: parsed.contentType,
        text_preview: text.slice(0, 300),
        link_count: links.length,
        _compacted: true,
        _note: text.length > 300
          ? `全文 ${text.length} 字符，已截取前 300 字符。`
          : undefined,
      });
    }

    case 'web_search': {
      const query = parsed.query as string | undefined;
      const error = parsed.error as string | undefined;
      const results = Array.isArray(parsed.results)
        ? (parsed.results as Array<Record<string, unknown>>)
        : [];
      const compacted = results.slice(0, 8).map(r => ({
        title: r.title ?? '',
        snippet: String(r.snippet ?? '').slice(0, 200),
        url: r.url ?? '',
      }));
      return JSON.stringify({
        query,
        error,
        result_count: parsed.resultCount ?? results.length,
        results: compacted,
        _compacted: true,
        _note: results.length > 8
          ? `共 ${results.length} 条结果，保留前 8 条。`
          : undefined,
      });
    }

    case 'execute_command': {
      const command = parsed.command as string | undefined;
      const args = parsed.args as string[] | undefined;
      const exitCode = parsed.exitCode as number | undefined;
      const stdout = (parsed.stdout as string | undefined) ?? '';
      const stderr = (parsed.stderr as string | undefined) ?? '';
      const cmdStr = `${command}${args?.length ? ' ' + args.join(' ') : ''}`;
      return JSON.stringify({
        command: cmdStr,
        exit_code: exitCode,
        stdout_tail: stdout.slice(-500),
        stderr_tail: stderr.slice(-500),
        _compacted: true,
        _note: `stdout ${stdout.length} 字符，stderr ${stderr.length} 字符，保留末尾 500 字符。`,
      });
    }

    case 'edit_lines':
    case 'replace_lines': {
      const path = parsed.path as string | undefined;
      const replaced = parsed.replaced_lines as number | undefined;
      const newCount = parsed.new_lines_count as number | undefined;
      const bytes = parsed.bytes_written as number | undefined;
      return JSON.stringify({
        path,
        replaced_lines: replaced,
        new_lines_count: newCount,
        bytes_written: bytes,
        _compacted: true,
        _note: replaced
          ? `替换 ${replaced} 行 → ${newCount} 行${bytes ? ` (${bytes} 字节)` : ''}`
          : undefined,
      });
    }

    default:
      return null;
  }
}

/**
 * 对 cachedUpTo 之后的新 tool_result 消息做结构化压缩。
 * 保留 toolCallId 和 role，只压缩 content 字段。
 */
function microcompactToolResults(messages: Message[], cachedUpTo: number): Message[] {
  const toolCallToName = buildToolNameMap(messages);
  let changedCount = 0;

  const result = messages.map((msg, i) => {
    if (i < cachedUpTo) return msg;
    if (msg.role !== 'tool' || !msg.toolCallId) return msg;

    const toolName = toolCallToName.get(msg.toolCallId);
    if (!toolName || !TOOLS_WITH_LARGE_OUTPUT.has(toolName)) return msg;

    const compacted = compactToolResult(toolName, msg.content);
    if (compacted === null) return msg;

    changedCount++;
    return { ...msg, content: compacted };
  });

  return result;
}

// ---- 3. Context Collapse: LLM 消息范围摘要 ----

/**
 * 当 token 超过预算阈值时，用 LLM 对最旧的一批消息范围做语义摘要。
 * 替换为一个 system 摘要消息，保留最近 N 轮不变。
 *
 * 这会修改缓存前缀 → 返回 collapsed=true。
 */
async function contextCollapse(
  messages: Message[],
  tokenBudget: number,
): Promise<{ messages: Message[]; finalTokens: number }> {
  const originalTokens = totalTokens(messages);

  if (originalTokens <= tokenBudget * config.agent.compactThreshold) {
    return { messages, finalTokens: originalTokens };
  }

  // 找到活跃窗口边界（保留最近 compactKeepRecentTurns 轮次的 user 消息及其后全部消息）
  const keepRecent = Math.max(1, Math.min(config.agent.compactKeepRecentTurns, config.agent.recentMessageWindow));
  let recentBoundary = messages.length;
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') userCount++;
    if (userCount >= keepRecent) {
      recentBoundary = i;
      break;
    }
  }

  // 收集可压缩的旧消息范围 [0..recentBoundary)
  // 跳过最前面的 system 消息（它们是环境/记忆/技能上下文，不应被压缩）
  let firstCompressible = 0;
  while (firstCompressible < recentBoundary && messages[firstCompressible]?.role === 'system') {
    firstCompressible++;
  }

  const compressible = messages.slice(firstCompressible, recentBoundary);
  if (compressible.length === 0) {
    return { messages, finalTokens: originalTokens };
  }

  // 构建摘要请求：包含 user、assistant、tool 的完整轮次上下文
  const transcript = compressible
    .map(m => {
      const role = m.role === 'tool' ? 'tool_result' : m.role;
      const preview = m.content?.slice(0, 800) ?? '';
      const hasToolCalls = m.toolCalls?.length ? ` [调用了 ${m.toolCalls.length} 个工具]` : '';
      return `[${role}]${hasToolCalls}: ${preview}`;
    })
    .join('\n\n');

  if (transcript.length < 50) {
    return { messages, finalTokens: originalTokens };
  }

  let summaryText = '';
  try {
    const promptMessages: Message[] = [{
      id: randomUUID(),
      role: 'user',
      content:
        `以下是 AI Agent 执行任务的历史记录。请将其压缩为一段简洁的摘要（300 字以内），` +
        `保留：已完成的关键操作、做出的决策、遇到的重要错误。只输出摘要文本，不要加前缀：\n\n${transcript}`,
      createdAt: new Date().toISOString(),
    }];
    for await (const chunk of getProvider().stream(promptMessages)) {
      if (chunk.textDelta) summaryText += chunk.textDelta;
    }
  } catch {
    return { messages, finalTokens: originalTokens };
  }

  if (!summaryText.trim()) {
    summaryText = buildDeterministicSummary(compressible);
  }
  summaryText = appendCompressedUserConstraints(summaryText.trim(), compressible);

  // 构建新的消息列表：system 前文 + 摘要 + 保留的活跃窗口
  const keptBefore = messages.slice(0, firstCompressible);
  const keptAfter = messages.slice(recentBoundary);

  const summaryRole: Message['role'] =
    compressible.some((m) => m.role === 'assistant') && !compressible.some((m) => m.role === 'tool')
      ? 'assistant'
      : 'system';
  const summaryMessage: Message = {
    id: randomUUID(),
    role: summaryRole,
    content: `[上下文压缩] ${summaryText.slice(0, config.agent.compressedMessageCharCap)}`,
    createdAt: new Date().toISOString(),
  };

  const compactedMessages = [...keptBefore, summaryMessage, ...keptAfter];
  const finalTokens = totalTokens(compactedMessages);

  return { messages: compactedMessages, finalTokens };
}

function buildDeterministicSummary(messages: Message[]): string {
  const importantUserText = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n')
    .slice(0, config.agent.compressedMessageCharCap);
  const roles = messages.map((message) => message.role).join(',');
  return `已压缩 ${messages.length} 条历史消息（${roles}）。保留关键用户约束和执行结论：${importantUserText}`;
}

function appendCompressedUserConstraints(summary: string, messages: Message[]): string {
  const userText = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n')
    .trim();
  if (!userText) return summary;
  const preserved = userText.slice(0, Math.max(80, Math.floor(config.agent.compressedMessageCharCap / 2)));
  return summary.includes(preserved) ? summary : `保留用户约束：${preserved}\n${summary}`;
}

// ---- 公共入口 ----

/**
 * 三层上下文压缩管线：
 *   Snip → Microcompact → Collapse（仅在超预算时）
 *
 * cache-aware：
 *   - cachedUpTo 之前的消息不动（它们在 prompt cache 中）
 *   - Context Collapse 执行时返回 collapsed=true，调用方应重置缓存边界为 0
 */
export async function compactContext(
  messages: Message[],
  cachedUpTo: number,
  tokenBudget?: number,
): Promise<CompactContextResult> {
  const budget = tokenBudget ?? config.agent.contextTokenBudget;
  const originalTokens = totalTokens(messages);

  // Step 1: Snip — 移除空 tool_result（仅新消息）
  const afterSnip = snipToolResults(messages, cachedUpTo);
  const snippedCount = messages.length - afterSnip.length;

  // Step 2: Microcompact — 结构化压缩（仅新消息）
  const afterMc = microcompactToolResults(afterSnip, cachedUpTo);

  // 计算被 microcompact 的条数
  let microCount = 0;
  for (let i = cachedUpTo; i < afterMc.length; i++) {
    if (afterMc[i]?.content !== messages[i]?.content) {
      microCount++;
    }
  }

  // Step 3: 检查是否需要 LLM Collapse
  const afterTokens = totalTokens(afterMc);

  if (afterTokens <= budget * config.agent.compactThreshold) {
    return {
      messages: afterMc,
      collapsed: false,
      stats: {
        snipped: snippedCount,
        microcompacted: microCount,
        cachedPrefixPreserved: true,
        savedTokens: originalTokens - afterTokens,
        originalTokens,
        finalTokens: afterTokens,
      },
    };
  }

  // Step 4: Context Collapse — LLM 语义摘要旧消息
  const collapsed = await contextCollapse(afterMc, budget);

  return {
    messages: collapsed.messages,
    collapsed: true,
    stats: {
      snipped: snippedCount,
      microcompacted: microCount,
      cachedPrefixPreserved: false,
      savedTokens: originalTokens - collapsed.finalTokens,
      originalTokens,
      finalTokens: collapsed.finalTokens,
    },
  };
}

// ---- Token 估算（保留，供 loop 使用）----

/**
 * 轻量 token 估算（不依赖 tiktoken）。
 * CJK 字符 ~1.5 token，拉丁/其他 ~0.25 token。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

function messageTokens(message: Message): number {
  let n = estimateTokens(message.content ?? '');
  if (message.reasoningContent) n += estimateTokens(message.reasoningContent);
  if (message.toolCalls?.length) {
    for (const tc of message.toolCalls) {
      n += estimateTokens(tc.function.arguments ?? '');
    }
  }
  return n;
}

export function totalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

/** 注入上下文的记忆条数上限（防止记忆膨胀挤占预算）。 */
const MAX_INJECTED_MEMORIES = 20;

/** M8: buildMemorySystemMessage 的返回值，包含消息本身和结构化引用列表。 */
export interface MemorySystemMessage {
  message: Message | null;
  citations: Citation[];
}

const CATEGORY_LABEL: Record<MemoryEntry['category'], string> = {
  preference: '偏好',
  directory: '常用目录',
  model: '模型偏好',
  habit: '习惯',
  fact: '事实',
  other: '其他',
};

// ---- P5: Memory 相关性评分 ----

interface ScoredMemory {
  entry: MemoryEntry;
  score: number;
}

/** 从文本中提取关键词（简单分词，去停用词，去短词）。 */
function extractKeywords(text: string): string[] {
  // 按非字母/非CJK字符拆分
  const tokens = text.toLowerCase().split(/[^a-z0-9一-鿿]+/i);
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
    'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very', 'just',
    'about', 'up', 'out', 'it', 'its', 'this', 'that', 'these', 'those',
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '们',
  ]);
  return tokens.filter((t) => t.length >= 2 && !stopWords.has(t));
}

/**
 * P5: 对记忆做相关性评分。
 * - 关键词命中（目标 + 最近话题）
 * - 分类匹配加权
 * - 置信度加权
 * - 时间衰减（每 30 天衰减一半）
 */
function scoreMemories(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[],
): ScoredMemory[] {
  const goalWords = extractKeywords(goal);
  const topicWords = recentTopics.flatMap((t) => extractKeywords(t));
  const allRelevant = new Set([...goalWords, ...topicWords]);

  return memories.map((m) => {
    let score = 0;
    const content = m.content.toLowerCase();

    // 1. 关键词命中
    for (const word of allRelevant) {
      if (content.includes(word)) score += 0.15;
    }

    // 2. 分类匹配加权
    if (m.category === 'directory' && /文件|目录|路径|file|dir|path/i.test(goal)) {
      score += 0.2;
    }
    if (m.category === 'model' && /模型|model|provider|llm|api/i.test(goal)) {
      score += 0.2;
    }
    if (m.category === 'preference' && /偏好|风格|格式|format|style/i.test(goal)) {
      score += 0.15;
    }

    // 3. 置信度加权
    score *= 0.5 + m.confidence * 0.5;

    // 4. 时间衰减（每 30 天衰减一半）
    const ageDays =
      (Date.now() - new Date(m.updatedAt).getTime()) / (1000 * 86400);
    score *= Math.pow(0.5, ageDays / 30);

    return { entry: m, score: Math.min(1, score) };
  });
}

// ---- M8: Time-aware 时间上下文 ----

/** 时间上下文类型 */
type TimeContext = 'recent' | 'past' | 'neutral' | 'future';

/**
 * 从 goal 中检测时间上下文。
 * 影响评分中的时间衰减系数。
 */
function detectTimeContext(goal: string): TimeContext {
  const lower = goal.toLowerCase();

  // 近期上下文
  if (/\b(当前|现在|最近|目前|today|current|recent|just now|now)\b/i.test(lower)) {
    return 'recent';
  }

  // 过往上下文
  if (/\b(之前|以前|过去|上周|上个月|昨天|before|past|previous|last|earlier|ago|yesterday)\b/i.test(lower)) {
    return 'past';
  }

  // 未来上下文
  if (/\b(计划|打算|将要|明天|下周|下个月|future|plan|next|tomorrow|upcoming)\b/i.test(lower)) {
    return 'future';
  }

  return 'neutral';
}

/**
 * 根据时间上下文调整时间衰减系数。
 * "recent" → 降低衰减速度（近期内容更重要）
 * "past"   → 降低衰减速度（回忆过往内容）
 * "future" → 正常衰减
 * "neutral" → 正常衰减
 */
function timeDecayMultiplier(context: TimeContext): number {
  switch (context) {
    case 'recent': return 4.0;  // 衰减速度减为 1/4（相当于 120 天半衰期）
    case 'past':   return 3.0;  // 衰减速度减为 1/3
    case 'future': return 1.0;  // 正常衰减
    case 'neutral': return 1.0; // 正常衰减
  }
}

/**
 * 带时间上下文的评分函数。
 * 在 scoreMemories 基础上，通过 timeDecayMultiplier 调整时间衰减速率。
 */
function scoreMemoriesWithTimeContext(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[],
  timeContext: TimeContext,
): ScoredMemory[] {
  const baseScores = scoreMemories(memories, goal, recentTopics);
  const multiplier = timeDecayMultiplier(timeContext);

  // 只有非 neutral 时才调整
  if (multiplier === 1.0) return baseScores;

  return baseScores.map((scored) => {
    const ageDays =
      (Date.now() - new Date(scored.entry.updatedAt).getTime()) / (1000 * 86400);
    // 原始 score 中已经包含了一次时间衰减 (Math.pow(0.5, ageDays/30))
    // 我们需要把它还原再重新应用调整后的衰减
    const originalDecay = Math.pow(0.5, ageDays / 30);
    const adjustedDecay = Math.pow(0.5, ageDays / (30 * multiplier));
    // 如果原衰减 > 0，用调整后的衰减替换；否则保持原分
    if (originalDecay > 0 && originalDecay !== 1.0) {
      const scoreWithoutDecay = scored.score / originalDecay;
      return {
        entry: scored.entry,
        score: scoreWithoutDecay * adjustedDecay,
      };
    }
    return scored;
  });
}

// ---- M8: 混合评分（关键词 + 向量） ----

/** 混合评分权重 alpha：0=纯向量，1=纯关键词，默认 0.5 等权。 */
let _hybridAlpha = 0.5;

/** 设置混合评分权重（设置界面可调）。 */
export function setHybridScoringAlpha(alpha: number): void {
  _hybridAlpha = Math.max(0, Math.min(1, alpha));
}

/** 获取当前混合评分权重。 */
export function getHybridScoringAlpha(): number {
  return _hybridAlpha;
}

/**
 * M8: 混合相关性评分（关键词 + 向量语义）。
 *
 * 在现有关键词评分基础上，叠加向量语义相似度。
 * 向量搜索仅在以下条件同时满足时启用：
 * 1. sqlite-vec 已加载
 * 2. embedding provider 已配置
 * 3. memory_vec 表存在数据
 *
 * 无法满足时静默降级为纯关键词评分（保持现有行为）。
 */
export async function scoreMemoriesHybrid(
  memories: MemoryEntry[],
  goal: string,
  recentTopics: string[],
): Promise<ScoredMemory[]> {
  // 1. 检测时间上下文（影响时间衰减系数）
  const timeContext = detectTimeContext(goal);

  // 2. 关键词评分（复用现有逻辑，但传入调整后的时间上下文）
  const keywordScores = scoreMemoriesWithTimeContext(memories, goal, recentTopics, timeContext);

  // 3. 向量评分（如果有 embedding provider + sqlite-vec）

  // 2. 向量评分（如果有 embedding provider + sqlite-vec）
  if (!isVecLoaded()) return keywordScores;

  const embProvider = getEmbeddingProvider();
  if (!embProvider) return keywordScores;

  const queryText = [goal, ...recentTopics]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!queryText) return keywordScores;

  try {
    const queryVec = await embProvider.embed(queryText);
    const vecResults = searchMemoryVec(queryVec, MAX_INJECTED_MEMORIES * 2);
    const vectorScores = new Map<string, number>();
    for (const r of vecResults) {
      // 距离 0~2，转为相似度 1~0
      vectorScores.set(r.memoryId, Math.max(0, 1 - r.distance));
    }

    // 3. 混合评分
    const alpha = _hybridAlpha;
    return memories.map((m) => {
      const kw = keywordScores.find((s) => s.entry.id === m.id);
      const kwScore = kw?.score ?? 0;
      const vecScore = vectorScores.get(m.id) ?? 0;
      return {
        entry: m,
        score: alpha * kwScore + (1 - alpha) * vecScore,
      };
    });
  } catch (err) {
    console.warn(
      '[context] 向量评分失败，降级为纯关键词:',
      err instanceof Error ? err.message : String(err),
    );
    return keywordScores;
  }
}

// ---- P5: [[link]] 引用解析 ----

/** 从记忆内容中解析 [[link]] 引用，返回被引用记忆的 nameSlug 列表。 */
function parseMemoryLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([a-z0-9-]+)\]\]/gi);
  return [...matches].map((m) => m[1].toLowerCase());
}

/**
 * P5: 展开关联记忆。
 * 对已选中记忆的 [[link]] 引用进行解析，把被引用记忆也拉入上下文（降权）。
 */
function expandLinkedMemories(
  selected: ScoredMemory[],
  allMemories: MemoryEntry[],
): ScoredMemory[] {
  const expanded = new Map<string, ScoredMemory>();
  for (const s of selected) expanded.set(s.entry.id, s);

  for (const s of selected) {
    const links = parseMemoryLinks(s.entry.content);
    for (const linkName of links) {
      // 检查是否已包含
      const alreadyIncluded = [...expanded.values()].some(
        (sm) => sm.entry.nameSlug === linkName,
      );
      if (alreadyIncluded) continue;

      // 按 nameSlug 查找关联记忆
      const linked = allMemories.find((m) => m.nameSlug === linkName);
      if (linked && !expanded.has(linked.id)) {
        expanded.set(linked.id, {
          entry: linked,
          score: s.score * 0.5, // 关联记忆降权
        });
      }
    }
  }

  return [...expanded.values()].sort((a, b) => b.score - a.score);
}

// ---- M8: 记忆摘要缓存 ----

/**
 * 刷新记忆摘要缓存。
 * 对给定目标执行完整的 score + expand + format，写入 memory_summary 表。
 * 不阻塞调用方（void fire-and-forget）。
 */
export async function refreshMemorySummary(memories: MemoryEntry[], goal?: string): Promise<void> {
  try {
    const recentTopics: string[] = [];
    const result = await buildMemorySystemMessageInner(memories, goal, recentTopics);
    if (result.message) {
      setMemorySummary(
        goal,
        result.message.content,
        JSON.stringify(result.citations),
        JSON.stringify(result.citations.map((c) => c.sourceId)),
        memories.filter((m) => m.enabled).length,
      );
    }
  } catch {
    // 缓存刷新失败不影响主流程
  }
}

/** buildMemorySystemMessage 的内部实现，供 refreshMemorySummary 共享。 */
async function buildMemorySystemMessageInner(
  memories: MemoryEntry[],
  goal?: string,
  recentTopics?: string[],
): Promise<MemorySystemMessage> {
  // (内部实现与 public 函数相同，见下方)
  const enabled = memories.filter((m) => m.enabled);
  if (enabled.length === 0) return { message: null, citations: [] };

  let selected: ScoredMemory[];
  let truncated = 0;

  if (goal) {
    const scored = (await scoreMemoriesHybrid(enabled, goal, recentTopics ?? []))
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score);
    const expanded = expandLinkedMemories(scored, enabled);
    selected = expanded.slice(0, MAX_INJECTED_MEMORIES);
    truncated = expanded.length - selected.length;
  } else {
    const sorted = enabled
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_INJECTED_MEMORIES);
    selected = sorted.map((m) => ({ entry: m, score: 1 }));
    truncated = enabled.length - sorted.length;
  }

  if (selected.length === 0) return { message: null, citations: [] };

  const citations: Citation[] = selected.map((s) => ({
    sourceId: s.entry.id,
    sourceType: 'memory' as const,
    content: s.entry.content.slice(0, 200),
    score: Math.round(s.score * 100) / 100,
    category: s.entry.category,
    nameSlug: s.entry.nameSlug,
  }));

  const lines = selected.map((s) => {
    const label = CATEGORY_LABEL[s.entry.category];
    const howTo = s.entry.howToApply ? ` —— ${s.entry.howToApply}` : '';
    return `- (${label}) ${s.entry.content}${howTo}`;
  });

  let content =
    '[关于用户的长期记忆]\n' +
    '以下是用户确认或你此前记录并启用的长期记忆，作为背景参考；' +
    '若与当前对话中的明确信息冲突，以当前对话为准：\n' +
    lines.join('\n');

  if (truncated > 0) {
    content += `\n\n（还有 ${truncated} 条相关度较低的记忆未列出）`;
  }

  return {
    message: { id: randomUUID(), role: 'system', content, createdAt: new Date().toISOString() },
    citations,
  };
}

/**
 * P5: 把启用的长期记忆构建为一条 system 消息，注入到 LLM 上下文最前面。
 *
 * M8: 优先使用缓存。记忆变更后调用方应触发 invalidateMemorySummary。
 * 缓存命中时直接返回，避免重复的 LLM 调用和 embedding 请求。
 */
export async function buildMemorySystemMessage(
  memories: MemoryEntry[],
  goal?: string,
  recentTopics?: string[],
): Promise<MemorySystemMessage> {
  // M8: 尝试命中缓存
  try {
    const cached = getMemorySummary(goal);
    if (cached) {
      const citations: Citation[] = cached.citations
        ? (JSON.parse(cached.citations) as Citation[])
        : [];
      return {
        message: cached.content
          ? { id: randomUUID(), role: 'system', content: cached.content, createdAt: new Date().toISOString() }
          : null,
        citations,
      };
    }
  } catch {
    // 缓存读取失败，继续实时计算
  }

  // 未命中缓存，实时计算
  return buildMemorySystemMessageInner(memories, goal, recentTopics);
}

/**
 * 构建环境上下文系统消息（始终注入）。
 *
 * 提供模型感知世界所必需的基础信息：
 * - 当前日期/时间
 * - 操作系统与平台
 * - 工作区目录（文件沙箱边界）
 * - Aurevoy 配置目录（skills / DB / 设置所在）
 * - 项目名称/路径
 */
export function buildSystemContextMessage(
  workspaceDir: string,
  configDir?: string,
  projectInfo?: { name: string; path: string },
): Message {
  const now = new Date();
  const timeStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const lines: string[] = [];
  lines.push('<system_context>');
  lines.push(`Current time: ${now.toISOString()}`);
  lines.push(`Today: ${timeStr}`);
  lines.push(`Platform: ${process.platform} ${process.arch}`);
  lines.push(`Shell: ${process.env.SHELL ?? 'unknown'}`);
  lines.push('');
  lines.push(`Workspace: ${workspaceDir}`);
  if (configDir) lines.push(`Config dir: ${configDir}`);
  if (projectInfo) {
    lines.push(`Project: ${projectInfo.name}`);
    lines.push(`Project path: ${projectInfo.path}`);
  }
  lines.push('</system_context>');

  return {
    id: randomUUID(),
    role: 'system',
    content: lines.join('\n'),
    createdAt: now.toISOString(),
  };
}

/**
 * 工具使用引导消息——指导 LLM 使用行级原语工具操作文件。
 *
 * 始终注入，放在环境上下文之后。
 */
export function buildToolGuidanceMessage(): Message {
  const content = [
    '<tool_usage_rules>',
    '文件读写必须使用行级原语工具：',
    '',
    '**读取文件**：open_file 定位 → scroll 浏览 → search_grep 搜索',
    '',
    '**写入文件三件套**：',
    '',
    '1. **write_file** — 原子全量写（≤50KB），新建或完全重写小文件',
    '   - 文件不存在则创建，存在则覆盖；通过先写临时文件再 rename 保证不会损坏目标',
    '   - 超 50KB 的内容返回错误——改用 session_open/session_write/session_close 分批写入',
    '',
    '2. **edit_lines** — 行级精确替换（≤200行/8KB），局部编辑',
    '   - 用 search_grep 或 open_file 确认行号后再编辑',
    '   - 适合：修 bug、改配置项、重写单个函数',
    '   - 如需整体重写小文件，用 write_file 一步完成',
    '   - 如需大范围新建，用 session_open/session_write/session_close',
    '',
    '3. **分批写入（大文件）**：',
    '   - session_open(path) → 返回 session_id',
    '   - session_write(session_id, content) × N 次（每次 ≤200行/10KB）',
    '   - session_close(session_id) → 原子 rename 到目标路径',
    '   - 场景：新建大型源文件、生成长篇文档、导出数据',
    '',
    '**辅助写入**：',
    '   - append_file(path, content) — 尾部追加少量内容（≤200行/8KB）',
    '   - create_file(path) — 建空文件占位',
    '',
    '**不要做的事**：',
    '- 不要在一个工具调用中塞入超过 200 行的内容',
    '- 不要用 edit_lines 一次写上千行——改用 session_* 分批',
    '- 不要担心 session_* 是多次调用——这就是设计意图',
    '</tool_usage_rules>',
  ].join('\n');

  return {
    id: randomUUID(),
    role: 'system',
    content,
    createdAt: new Date().toISOString(),
  };
}
