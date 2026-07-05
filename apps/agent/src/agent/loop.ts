import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  AutoModeLevel,
  AutoModeState,
  ContentBlock,
  ContentBlockType,
  FileSnapshot,
  Message,
  MessageAttachment,
  MessageToolCall,
  PlanStep,
  RevertMode,
  Task,
  TaskErrorCategory,
  TaskPhase,
  TaskStatus,
  TaskTraceEntry,
  TaskBudget,
  ToolCall,
  ToolResult,
  ToolRiskLevel,
} from '@aurevoy/shared';
import { taskEvents } from './events.js';
import { getProvider, getProviderName, type AccumulatedToolCall } from '../llm/provider.js';
import { assertRealPathInside, resolveInWorkspace } from '../tools/builtins.js';
import { taskStore, projectStore } from '../store/db.js';
import { createTaskLogger } from '../logging/trace.js';
import { config } from '../config.js';
import { runPiTask } from './pi-runtime.js';
import {
  BudgetExceededError,
  initialBudgetUsage,
  markArtifactApplied,
  normalizeBudget,
} from './m6-state.js';

/** 基础只读工具免审批；其余工具仅允许当前任务会话内临时批准。 */
const APPROVAL_FREE_TOOLS = new Set(['list_directory', 'load_skill', 'open_file', 'scroll', 'search_grep']);

/** plan 模式下允许自动批准的只读勘探工具 */
const PLANMODE_TOOLS = new Set([
  'list_directory', 'glob', 'get_current_time', 'load_skill',
  'open_file', 'scroll', 'search_grep',
]);

/** auto-edit 等级下自动批准的安全文件工具（读写+搜索，不自动批准 shell/网络） */
const AUTO_EDIT_TOOLS = new Set([
  ...PLANMODE_TOOLS,
  'apply_artifact', 'move_file', 'copy_file', 'rename_file',
  'create_file', 'write_file', 'edit_lines', 'append_file',
  'session_open', 'session_write', 'session_close',
  'create_artifact',
]);

/** 获取当前有效的 auto mode level：全局 config 为准，任务级 plan mode 降级覆盖 */
function getEffectiveAutoModeLevel(task: Task): AutoModeLevel {
  const override = task.autoModeState?.level;
  if (override && override !== (config.autoMode.level as AutoModeLevel)) return override;
  const level = config.autoMode.level;
  if (level === 'off' || level === 'plan' || level === 'auto-edit' || level === 'full') return level;
  return 'off';
}

/**
 * 判断工具在 auto mode 下需要审批的原因。
 * - off/paused → 'paused' (auto mode 关闭或暂停)
 * - plan + 不在 PLANMODE_TOOLS → 'not_covered'（写工具被 plan mode 拦截）
 * - full → 始终自动批准，无原因
 * - auto-edit + 不在 AUTO_EDIT_TOOLS → 'not_covered'
 * - 否则自动批准，无原因
 */
function autoModeApprovalReason(
  level: AutoModeLevel,
  paused: boolean,
  toolName: string,
): 'not_covered' | 'paused' | undefined {
  if (level === 'off' || paused) return 'paused';
  if (level === 'plan') {
    if (PLANMODE_TOOLS.has(toolName)) return undefined;
    return 'not_covered'; // 写工具在 plan mode 中被拦截
  }
  if (level === 'full') {
    return undefined;
  }
  if (level === 'auto-edit') {
    if (AUTO_EDIT_TOOLS.has(toolName)) return undefined;
    return 'not_covered';
  }
  return undefined;
}

/** 根据 auto mode 等级注入差异化系统提示词 */
function buildModeSystemMessage(level: AutoModeLevel): Message | null {
  if (level === 'off' || level === 'plan') {
    // plan mode: 只读勘探提示
    if (level === 'plan') {
      return {
        id: `mode-${randomUUID()}`,
        role: 'system',
        content:
          'You are in **Plan Mode** — a read-only exploration and planning phase.\n\n' +
          'Rules:\n' +
          '1. You can ONLY read files, search the codebase, list directories, and ask the user questions.\n' +
          '2. You CANNOT write, edit, create, or delete any files — those tools are blocked until the plan is approved.\n' +
          '3. Your goal is to understand the problem, explore the codebase, design a solution, and present a clear implementation plan.\n' +
          '4. When you are ready to present your plan, describe the approach step by step. The user will approve it before execution begins.\n' +
          '5. If you try to use a write tool, it will be rejected with a notification that you are in plan mode.\n\n' +
          'Focus on: exploration, analysis, design, and clear planning.',
        createdAt: new Date().toISOString(),
      };
    }
    // off mode: 无需额外提示词
    return null;
  }

  let modePrompt: string;
  if (level === 'auto-edit') {
    modePrompt =
      'You are in **Auto-edit Mode**.\n\n' +
      'Rules:\n' +
      '1. File read, write, edit, search, and artifact operations are **auto-approved** — they execute immediately.\n' +
      '2. Shell commands and network requests will **prompt for your approval** before they run.\n' +
      '3. Use file operations freely to explore and edit the codebase. For shell commands, explain briefly so the user can approve quickly.\n' +
      '4. When you need to run a command, first explain what it does and why, then call the tool.';
  } else if (level === 'full') {
    modePrompt =
      'You are in **Full Auto Mode**.\n\n' +
      'Rules:\n' +
      '1. **All tools are auto-approved** and execute immediately — no approval prompts.\n' +
      '2. Proceed autonomously: explore, edit, run commands, and iterate as needed.\n' +
      '3. After long runs of auto-approved actions, the system may pause and ask you to confirm before continuing.\n\n' +
      'Focus on: getting the job done efficiently.';
  } else {
    return null;
  }

  return {
    id: `mode-${randomUUID()}`,
    role: 'system',
    content: modePrompt,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 检测任务是否足够复杂，需要自动进入 Plan Mode。
 * 基于目标文本的启发式规则，配合可选的 Plan Agent scout 结果。
 */
function shouldAutoPlan(goal: string): boolean {
  if (!goal || goal.length < 80) return false;
  // 关键词匹配
  const complexKeywords = [
    /design/i, /architecture/i, /refactor/i, /restructure/i,
    /migrate/i, /redesign/i, /overhaul/i, /reorganize/i,
    /multi[-\s]?(step|stage|phase|tier)/i, /cross[-\s]cutting/i,
    /integration/i, /scaffold/i, /from\s+scratch/i,
  ];
  const matchCount = complexKeywords.filter((re) => re.test(goal)).length;
  if (matchCount >= 2) return true;
  if (goal.length >= 150 && matchCount >= 1) return true;
  return false;
}

/** 初始化 AutoModeState */
function initAutoModeState(level: AutoModeLevel, preMode?: AutoModeLevel): AutoModeState {
  return {
    level,
    autoApprovedCalls: 0,
    blockedByRules: 0,
    paused: false,
    consecutiveAutoCalls: 0,
    fallbackCount: 0,
    planReady: false,
    planPreMode: preMode,
  };
}

/** 进程重启后不会再有内存执行句柄的状态；启动时必须收敛成可解释失败。 */
const INTERRUPTED_STATUSES: readonly TaskStatus[] = ['pending', 'planning', 'running', 'paused'];
/** 进行中任务的取消句柄 */
const activeAbortControllers = new Map<string, AbortController>();

/** 等待中的工具审批：taskId → (callId → 决策回调) */
const pendingApprovals = new Map<
  string,
  Map<string, (approved: boolean, sessionApprove?: boolean) => void>
>();
/** 等待中的用户追问：taskId → (clarificationId → 回复回调) */
const pendingClarifications = new Map<string, Map<string, (answer: string | null) => void>>();

/** 等待中的计划审批：taskId → 决策回调（approved + 可选拒绝原因） */
const pendingPlanApprovals = new Map<string, (approved: boolean, reason?: string) => void>();

/** API 层调用：投递用户的计划审批决策到等待中的 Plan Agent 循环 */
export function resolvePlanApproval(taskId: string, approved: boolean, reason?: string): boolean {
  const resolve = pendingPlanApprovals.get(taskId);
  if (!resolve) return false;
  pendingPlanApprovals.delete(taskId);
  resolve(approved, reason);
  return true;
}

/** 等待用户对 Plan Agent 生成的计划做出审批决策 */
export function waitForPlanApproval(taskId: string, signal: AbortSignal): Promise<{ approved: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const onAbort = () => {
      pendingPlanApprovals.delete(taskId);
      resolve({ approved: false, reason: 'cancelled' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pendingPlanApprovals.set(taskId, (approved, reason) => {
      signal.removeEventListener('abort', onAbort);
      pendingPlanApprovals.delete(taskId);
      resolve({ approved, reason });
    });
  });
}

/** 取消一个进行中的任务（hard cancel：中断 fetch 流） */
export function cancelTask(taskId: string): boolean {
  const ac = activeAbortControllers.get(taskId);
  if (!ac) return false;
  ac.abort();
  const clarifications = pendingClarifications.get(taskId);
  for (const resolve of clarifications?.values() ?? []) resolve(null);
  pendingClarifications.delete(taskId);
  pendingApprovals.delete(taskId);
  return true;
}

/** 该任务当前是否有正在执行的循环（用于续聊并发守卫）。 */
export function isTaskRunning(taskId: string): boolean {
  return activeAbortControllers.has(taskId);
}

/**
 * 启动期恢复扫描：SQLite 里仍处于运行态/等待态的任务，说明上一次进程已中断。
 *
 * 这里不自动续跑，因为审批、外部工具副作用和用户意图都可能已经过期；
 * 先收敛为可解释的 failed，再由用户显式 resume。
 */
export function markInterruptedTasksAfterRestart(): Task[] {
  const recovered: Task[] = [];
  for (const task of taskStore.list()) {
    if (!INTERRUPTED_STATUSES.includes(task.status)) continue;
    const previousStatus = task.status;
    const previousPhase = task.phase;
    task.status = 'failed';
    task.phase = 'failed';
    task.plan = task.plan.map((step) =>
      step.status === 'completed' ? step : { ...step, status: 'failed' },
    );
    task.updatedAt = new Date().toISOString();
    taskStore.save(task);
    writeTrace(task.id, 'error', 'failed', {
      ok: false,
      errorCategory: 'unknown',
      summary: '引擎启动时发现任务在上次进程中断前未结束，已标记为可恢复失败',
      data: { previousStatus, previousPhase, recoveredAt: task.updatedAt },
    });
    recovered.push(task);
  }
  return recovered;
}

/**
 * 恢复一个历史任务：不追加假用户输入，只修补协议层悬空工具结果后重新运行。
 *
 * 某些 LLM API 要求 assistant tool_calls 后必须紧跟 tool 结果；如果崩溃发生在
 * 工具调用与结果写入之间，直接续跑会被 Provider 拒绝，因此恢复前先写入可解释结果。
 */
export function prepareTaskForResume(task: Task): Task {
  const now = new Date().toISOString();
  const previousStatus = task.status;
  const previousPhase = task.phase;
  const patchedToolResults = patchDanglingToolResults(task.messages);
  const lastCheckpoint = task.checkpoints?.at(-1);
  task.status = 'pending';
  task.phase = 'initializing';
  task.plan = resumePlanFromCheckpoint(task.plan, lastCheckpoint?.stepId);
  task.updatedAt = now;
  taskStore.save(task);
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: lastCheckpoint
      ? `用户恢复历史任务，从 checkpoint 继续：${lastCheckpoint.label}`
      : '用户恢复历史任务，使用持久消息历史重新进入 Agent 循环',
    data: { previousStatus, previousPhase, patchedToolResults, checkpoint: lastCheckpoint },
  });
  return task;
}

/**
 * 编辑重跑（Claude Code Rewind 的对话截断语义）：
 * 把目标消息及其之后的所有消息从活跃历史移除，使任务回到该消息发送前的状态。
 * 不回滚已落盘文件（Aurevoy 当前无 per-tool 文件快照，且已 apply 的产物不应被静默回滚）。
 * 截断前将移除的消息归档到 archivedMessages（支持 unrevert）。
 *
 * - code_and_conv: 截断对话 + 清除 checkpoint/artifact/plan（完整重做）
 * - conv_only: 仅截断对话，保留 checkpoint/artifact/plan（文件没问题，只想重新推理）
 *
 * 截断后调用方通常再 addUserTurn(编辑后的文本) + runTask，实现"带上下文从该点重新生成"。
 */
export function revertTask(
  task: Task,
  messageId: string,
  mode: RevertMode = 'code_and_conv',
): {
  task: Task;
  removedContent: string | null;
  removedMessageId: string | null;
  removedCount: number;
} {
  const index = task.messages.findIndex((m) => m.id === messageId);
  if (index < 0) {
    return { task, removedContent: null, removedMessageId: null, removedCount: 0 };
  }

  const removed = task.messages[index];
  const removedMessages = task.messages.slice(index);
  const removedCount = removedMessages.length;

  task.archivedMessages = removedMessages;
  task.messages = task.messages.slice(0, index);

  if (mode === 'code_and_conv') {
    const revertTime = removed.createdAt;
    task.checkpoints = (task.checkpoints ?? []).filter((cp) => cp.createdAt < revertTime);
    task.artifacts = (task.artifacts ?? []).filter((artifact) => {
      if (artifact.status === 'applied') return true;
      return artifact.createdAt < revertTime;
    });
    task.plan = task.plan.filter((step) => step.status === 'completed');

    // P6: 回滚被截断消息关联的文件写入（从快照恢复）
    const removedCallIds = new Set(
      removedMessages.flatMap((m) => m.toolCalls ?? []).map((tc) => tc.id),
    );
    const snapshotsToRestore = (task.fileSnapshots ?? [])
      .filter((s) => removedCallIds.has(s.callId));
    if (snapshotsToRestore.length > 0) {
      restoreFilesFromSnapshots(task, snapshotsToRestore).catch(() => {
        // 文件恢复失败不阻塞 revert 操作
      });
    }
  }

  task.status = 'paused';
  task.phase = null;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  taskEvents.publish({
    type: 'reverted',
    taskId: task.id,
    messageId,
    removedCount,
    archivedCount: removedMessages.length,
  });

  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `编辑重跑(mode=${mode})：截断到消息 ${messageId} 之前，移除 ${removedCount} 条消息（已归档），不回滚已落盘文件`,
    data: { messageId, mode, removedCount, archivedCount: removedMessages.length },
  });

  return {
    task,
    removedContent: removed.role === 'user' ? removed.content : null,
    removedMessageId: removed.id,
    removedCount,
  };
}

/**
 * 撤销上一次 revert：从 archivedMessages 恢复被截断的消息到活跃历史。
 * 仅在 revert 后尚未提交新的 continue 时可用（archivedMessages 非空且任务处于 paused）。
 */
export function unrevertTask(task: Task): { task: Task; restoredCount: number } {
  const archived = task.archivedMessages ?? [];
  if (archived.length === 0) {
    return { task, restoredCount: 0 };
  }

  task.messages = [...task.messages, ...archived];
  task.archivedMessages = [];

  const lastMessage = task.messages.at(-1);
  task.status = lastMessage?.role === 'user' ? 'completed' : 'completed';
  task.phase = 'finalizing';
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  const restoredCount = archived.length;

  taskEvents.publish({
    type: 'unreverted',
    taskId: task.id,
    restoredCount,
  });

  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `撤销编辑重跑：恢复 ${restoredCount} 条归档消息到活跃历史`,
    data: { restoredCount },
  });

  return { task, restoredCount };
}

/**
 * 从指定消息处分支出一个新任务（非破坏性 fork）。
 * 克隆父任务到目标消息（含）为止的所有消息，每条消息分配新 ID，
 * 新任务独立演进，原任务不受影响。
 */
export function branchTask(
  parentTask: Task,
  messageId: string,
  goalOverride?: string,
): { task: Task; messageCount: number } {
  const index = parentTask.messages.findIndex((m) => m.id === messageId);
  if (index < 0) {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      goal: goalOverride ?? parentTask.goal,
      status: 'pending',
      phase: 'initializing',
      plan: [],
      messages: [],
      parentTaskId: parentTask.id,
      projectId: parentTask.projectId,
      createdAt: now,
      updatedAt: now,
    };
    taskStore.save(task);
    return { task, messageCount: 0 };
  }

  const sourceMessages = parentTask.messages.slice(0, index + 1);
  const idMap = new Map<string, string>();
  for (const msg of sourceMessages) {
    idMap.set(msg.id, randomUUID());
  }

  const clonedMessages: Message[] = sourceMessages.map((msg) => {
    const cloned: Message = {
      ...msg,
      id: idMap.get(msg.id)!,
    };
    if (cloned.toolCalls) {
      cloned.toolCalls = cloned.toolCalls.map((tc) => ({
        ...tc,
        id: idMap.get(tc.id) ?? randomUUID(),
      }));
    }
    if (cloned.toolCallId) {
      cloned.toolCallId = idMap.get(cloned.toolCallId) ?? cloned.toolCallId;
    }
    return cloned;
  });

  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    goal: goalOverride ?? parentTask.goal,
    status: 'completed',
    phase: 'finalizing',
    plan: [],
    messages: clonedMessages,
    parentTaskId: parentTask.id,
    projectId: parentTask.projectId,
    createdAt: now,
    updatedAt: now,
  };
  taskStore.save(task);

  taskEvents.publish({
    type: 'branched',
    taskId: task.id,
    parentTaskId: parentTask.id,
    messageId,
    messageCount: clonedMessages.length,
  });

  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `从任务 ${parentTask.id} 分支，克隆 ${clonedMessages.length} 条消息到消息 ${messageId}`,
    data: { parentTaskId: parentTask.id, messageId, messageCount: clonedMessages.length },
  });

  return { task, messageCount: clonedMessages.length };
}

/**
 * 将指定消息范围压缩为 LLM 生成的摘要（上下文窗口管理）。
 * 替换原消息为一条 system 摘要消息，释放上下文空间。
 * 不截断对话，仅压缩旧消息。
 */
export async function compactTask(
  task: Task,
  fromMessageId?: string,
  toMessageId?: string,
): Promise<{ task: Task; originalCount: number; summaryLength: number }> {
  const messages = task.messages;
  const fromIndex = fromMessageId
    ? messages.findIndex((m) => m.id === fromMessageId)
    : 0;
  const toIndex = toMessageId
    ? messages.findIndex((m) => m.id === toMessageId)
    : messages.length - 1;

  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) {
    return { task, originalCount: 0, summaryLength: 0 };
  }

  const toCompress = messages.slice(fromIndex, toIndex + 1);
  if (toCompress.length <= 1) {
    return { task, originalCount: toCompress.length, summaryLength: 0 };
  }

  const transcript = toCompress
    .map((m) => `[${m.role}]: ${m.content.slice(0, 800)}`)
    .join('\n\n');

  let summaryText = '';
  try {
    const promptMessages: Message[] = [
      {
        id: randomUUID(),
        role: 'user',
        content: `请将以下对话记录压缩为一段简洁的摘要（200字以内），保留关键信息、决策和结论。只输出摘要文本，不要加前缀：\n\n${transcript}`,
        createdAt: new Date().toISOString(),
      },
    ];
    for await (const chunk of getProvider().stream(promptMessages)) {
      if (chunk.textDelta) summaryText += chunk.textDelta;
    }
  } catch (err) {
    writeTrace(task.id, 'error', null, {
      ok: false,
      errorCategory: 'model',
      errorMessage: err instanceof Error ? err.message : String(err),
      summary: 'compact LLM 摘要调用失败',
    });
    return { task, originalCount: toCompress.length, summaryLength: 0 };
  }

  if (!summaryText.trim()) {
    return { task, originalCount: toCompress.length, summaryLength: 0 };
  }

  const summaryMessage: Message = {
    id: randomUUID(),
    role: 'system',
    content: `[上下文摘要] ${summaryText.trim()}`,
    createdAt: new Date().toISOString(),
  };

  const before = messages.slice(0, fromIndex);
  const after = messages.slice(toIndex + 1);
  task.messages = [...before, summaryMessage, ...after];

  const originalCount = toCompress.length;
  const summaryLength = summaryText.trim().length;

  task.updatedAt = new Date().toISOString();
  taskStore.save(task);

  taskEvents.publish({
    type: 'compacted',
    taskId: task.id,
    originalCount,
    summaryLength,
  });

  writeTrace(task.id, 'phase', null, {
    ok: true,
    summary: `压缩 ${originalCount} 条消息为 ${summaryLength} 字符摘要`,
    data: { fromIndex, toIndex, originalCount, summaryLength },
  });

  return { task, originalCount, summaryLength };
}

/** 解析用户输入中的斜杠命令前缀。/plan 只触发 Plan Agent，不作为 skill。 */
function parseSlashCommand(content: string): { planRequested: boolean; text: string } {
  const match = content.match(/^\/(\S+)(?:\s+(.*))?/s);
  if (!match) return { planRequested: false, text: content };
  const command = match[1];
  if (command === 'compact') return { planRequested: false, text: content };
  if (command === 'plan') {
    return { planRequested: true, text: match[2]?.trim() || '' };
  }
  return { planRequested: false, text: content };
}

/**
 * 在同一任务内追加一轮用户输入（多轮对话）。
 *
 * 仅追加 user 消息并持久化、广播；调用方随后再 `runTask(task)`，
 * 循环会带着完整的历史 `task.messages` 作为上下文继续推进。
 */
export function addUserTurn(
  task: Task,
  content: string,
  attachments?: MessageAttachment[],
): Message {
  // Skill: 解析斜杠命令前缀
  const parsed = parseSlashCommand(content);
  let messageContent = content;
  task.planMode = parsed.planRequested ? 'manual' : undefined;
  if (parsed.planRequested) {
    messageContent = parsed.text || task.goal;
    task.goal = messageContent;
  }

  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: messageContent,
    createdAt: new Date().toISOString(),
    attachments,
  };
  task.messages.push(userMsg);
  // 复用任务时，从终态回到待运行；phase 进入 initializing
  task.status = 'pending';
  task.phase = 'initializing';
  task.updatedAt = userMsg.createdAt;
  taskStore.save(task);
  taskEvents.publish({ type: 'message', taskId: task.id, message: userMsg });
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: '收到后续输入，继续任务',
    data: { message: messageContent },
  });
  return userMsg;
}

/**
 * 恢复已暂停的 auto mode（重置连续计数 + 取消暂停状态）。
 * 前端通过 API 调用，允许用户在一次安全暂停后继续自动执行。
 */
export function resumeAutoMode(taskId: string): boolean {
  const task = taskStore.get(taskId);
  if (!task?.autoModeState?.paused) return false;
  task.autoModeState.paused = false;
  task.autoModeState.pausedReason = undefined;
  task.autoModeState.consecutiveAutoCalls = 0;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
  taskEvents.publish({ type: 'auto_mode_state', taskId, state: { ...task.autoModeState } });
  return true;
}

/** 投递一次工具审批决策（由 server 的审批端点调用）。返回是否命中等待中的请求。 */
export function resolveApproval(
  taskId: string,
  callId: string,
  approved: boolean,
  sessionApprove?: boolean,
): boolean {
  const resolve = pendingApprovals.get(taskId)?.get(callId);
  if (!resolve) return false;
  resolve(approved, sessionApprove);
  return true;
}

/** 投递一次用户追问回复；返回是否命中等待中的请求。 */
export function resolveClarificationAnswer(
  taskId: string,
  clarificationId: string,
  answer: string,
): boolean {
  const resolve = pendingClarifications.get(taskId)?.get(clarificationId);
  if (!resolve) return false;
  resolve(answer);
  return true;
}

/** 等待用户对某次工具调用的审批；超时或任务取消视为拒绝。 */
interface ApprovalResult {
  approved: boolean;
  sessionApprove?: boolean;
  /** 命令前缀 key（如 cmd:rm），选中"允许本 session 内的 <cmd> 命令"时传入 */
  prefixKey?: string;
}

function waitForApproval(
  taskId: string,
  callId: string,
  signal: AbortSignal,
): Promise<ApprovalResult> {
  return new Promise<ApprovalResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const map = pendingApprovals.get(taskId);
      map?.delete(callId);
      if (map && map.size === 0) pendingApprovals.delete(taskId);
    };
    const finish = (approved: boolean, sessionApprove?: boolean, prefixKey?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ approved, sessionApprove, prefixKey });
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), config.agent.approvalTimeoutMs);

    if (signal.aborted) return finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    let map = pendingApprovals.get(taskId);
    if (!map) {
      map = new Map();
      pendingApprovals.set(taskId, map);
    }
    map.set(callId, finish);
  });
}

export const agentLoopInternals = {
  activeAbortControllers,
  waitForApproval,
  approvalKeyForCall,
  prefixApprovalKeyForCall,
  isApprovalFreeTool,
  autoModeApprovalReason,
  addPendingApproval,
  removePendingApproval,
  rememberSessionApproval,
  waitForClarification,
  waitForPlanApproval,
  getEffectiveAutoModeLevel,
  initAutoModeState,
  shouldAutoPlan,
  buildModeSystemMessage,
  resolveTaskWorkspace,
  collectExternalPaths,
  buildAttachmentSystemMessage,
  captureFileSnapshot,
  handleToolSideEffects,
  classifyError,
  summarizePayload,
  estimatePayloadBytes,
  writeTrace,
  writeToolCallTrace,
  writeApprovalTrace,
  finishCompleted,
  finishCancelled,
  makeAssistant,
  makeAssistantWithToolCalls,
  makeToolResult,
};

function approvalKeyForCall(call: ToolCall): string {
  if (call.toolName !== 'execute_command') return `tool:${call.toolName}`;
  const args = call.args as Record<string, unknown>;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  const commandArgs = Array.isArray(args.args)
    ? args.args.map((item) => String(item))
    : [];
  const cwd = typeof args.cwd === 'string' ? args.cwd.trim() : '';
  const envEntries =
    args.env && typeof args.env === 'object' && !Array.isArray(args.env)
      ? Object.entries(args.env as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .sort(([a], [b]) => a.localeCompare(b))
      : [];
  return JSON.stringify({
    tool: call.toolName,
    command,
    args: commandArgs,
    cwd,
    env: envEntries,
  });
}

function isApprovalFreeTool(toolName: string): boolean {
  return APPROVAL_FREE_TOOLS.has(toolName);
}

/** 获取命令审批的 key（前缀匹配，如 cmd:rm、cmd:git）。仅对 execute_command 生效。 */
function prefixApprovalKeyForCall(call: ToolCall): string {
  if (call.toolName !== 'execute_command') return '';
  const args = call.args as Record<string, unknown>;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  const prefix = command.split(/\s+/)[0] || command;
  return prefix ? `cmd:${prefix}` : '';
}

function addPendingApproval(task: Task, call: ToolCall, riskLevel: ToolRiskLevel, autoModeReason?: 'blocked_by_rule' | 'not_covered' | 'paused'): void {
  const next = (task.pendingApprovals ?? []).filter((item) => item.call.id !== call.id);
  next.push({ call, riskLevel, createdAt: new Date().toISOString(), autoModeReason });
  task.pendingApprovals = next;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
}

function removePendingApproval(task: Task, callId: string): void {
  const next = (task.pendingApprovals ?? []).filter((item) => item.call.id !== callId);
  if (next.length === (task.pendingApprovals ?? []).length) return;
  task.pendingApprovals = next;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
}

function rememberSessionApproval(task: Task, key: string): void {
  const next = [...new Set([...(task.approvedApprovalKeys ?? []), key])];
  task.approvedApprovalKeys = next;
  task.updatedAt = new Date().toISOString();
  taskStore.save(task);
}

/** 等待用户回复追问；超时或任务取消返回 null，不伪造用户输入。 */
function waitForClarification(
  taskId: string,
  clarificationId: string,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const map = pendingClarifications.get(taskId);
      map?.delete(clarificationId);
      if (map && map.size === 0) pendingClarifications.delete(taskId);
    };
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answer);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), config.agent.approvalTimeoutMs);

    if (signal.aborted) return finish(null);
    signal.addEventListener('abort', onAbort, { once: true });
    let map = pendingClarifications.get(taskId);
    if (!map) {
      map = new Map();
      pendingClarifications.set(taskId, map);
    }
    map.set(clarificationId, finish);
  });
}

/** 创建一个新任务并持久化（尚未开始执行） */
export function createTask(
  goal: string,
  budget?: TaskBudget,
  projectId?: string,
  attachments?: MessageAttachment[],
): Task {
  const now = new Date().toISOString();
  const parsed = parseSlashCommand(goal);
  const taskGoal = parsed.planRequested ? (parsed.text || goal) : goal;
  const userMsg: Message = {
    id: randomUUID(),
    role: 'user',
    content: taskGoal,
    createdAt: now,
    attachments,
  };
  const task: Task = {
    id: randomUUID(),
    goal: taskGoal,
    status: 'pending',
    phase: 'initializing',
    plan: [],
    messages: [userMsg],
    artifacts: [],
    clarifications: [],
    pendingApprovals: [],
    approvedApprovalKeys: [],
    checkpoints: [],
    budget: normalizeBudget(budget),
    budgetUsage: initialBudgetUsage(),
    tokenUsage: { available: false, provider: getProviderName(), model: config.llm.model },
    projectId: projectId ?? undefined,
    planMode: parsed.planRequested ? 'manual' : undefined,
    createdAt: now,
    updatedAt: now,
  };
  taskStore.save(task);
  writeTrace(task.id, 'phase', 'initializing', {
    ok: true,
    summary: '任务已创建',
    data: { goal: taskGoal, planMode: task.planMode },
  });
  return task;
}

/**
 * 解析任务的有效工作区目录。
 * - 有项目：使用项目目录
 * - 无项目：使用全局 workspace/.sessions/<taskId> 隔离
 */
export async function resolveTaskWorkspace(task: Task): Promise<string> {
  if (task.projectId) {
    const project = projectStore.get(task.projectId);
    if (project) return resolve(project.path);
  }
  const standaloneDir = resolve(config.workspaceDir, '.sessions', task.id);
  await fs.mkdir(standaloneDir, { recursive: true });
  return standaloneDir;
}

/** P6: 在写操作前捕获文件快照（用于 Rewind 回滚）。 */
async function captureFileSnapshot(
  filePath: string,
  taskId: string,
  workspaceDir: string,
): Promise<string | null> {
  const snapshotDir = join(workspaceDir, '.aurevoy-snapshots', taskId);
  await fs.mkdir(snapshotDir, { recursive: true });
  const snapshotId = randomUUID();
  const snapshotPath = join(snapshotDir, snapshotId);

  try {
    await fs.copyFile(filePath, snapshotPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 文件不存在（即将创建），记录空快照
      await fs.writeFile(snapshotPath, '', 'utf8');
    } else {
      return null; // 快照失败不阻塞操作
    }
  }

  return snapshotId;
}

/** P6: 从快照恢复文件（Rewind 时调用）。 */
async function restoreFilesFromSnapshots(
  task: Task,
  snapshots: FileSnapshot[],
): Promise<void> {
  const workspaceDir = await resolveTaskWorkspace(task);
  for (const snapshot of snapshots) {
    const snapshotPath = join(
      workspaceDir,
      '.aurevoy-snapshots',
      task.id,
      snapshot.id,
    );
    const targetPath = resolve(workspaceDir, snapshot.path);
    try {
      const stat = await fs.stat(snapshotPath);
      if (stat.size === 0) {
        // 空快照 = 文件在写入前不存在，删除目标文件
        await fs.unlink(targetPath).catch(() => {});
      } else {
        await fs.copyFile(snapshotPath, targetPath);
      }
    } catch {
      // 快照文件可能已被清理
    }
  }
}

/**
 * 从任务的所有用户消息附件中收集外部路径。
 * 这些路径由用户显式提供，应绕过工作区沙箱限制。
 */
function collectExternalPaths(task: Task): string[] {
  const paths: string[] = [];
  for (const msg of task.messages) {
    if (msg.role === 'user' && msg.attachments?.length) {
      for (const att of msg.attachments) {
        paths.push(att.path);
      }
    }
  }
  return [...new Set(paths)];
}

/** 已知的文本文件扩展名集合，用于判断附件是否可直接读入上下文。 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.json5',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.xml', '.svg',
  '.md', '.mdx', '.markdown',
  '.txt', '.log', '.csv',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.hh',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql',
  '.vue', '.svelte', '.astro',
  '.prisma', '.proto',
  '.gitignore', '.gitattributes', '.editorconfig',
  '.eslintrc', '.prettierrc',
]);

function isTextFile(mimeType: string, name: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext);
}

/** 最大注入到上下文中的单文件字符数（~8K tokens，防止单文件撑满窗口）。 */
const MAX_ATTACHMENT_CONTENT_CHARS = 30_000;

/**
 * 为任务中带附件的用户消息构建附加上下文。
 * 读取文本文件内容，合成为一条 system 消息，注入到 LLM 请求中。
 */
async function buildAttachmentSystemMessage(task: Task): Promise<string | null> {
  // 找到所有带附件的用户消息（取最新的那条，避免多轮重复注入）
  const messagesWithAttachments = task.messages.filter(
    (m) => m.role === 'user' && m.attachments && m.attachments.length > 0,
  );
  if (messagesWithAttachments.length === 0) return null;

  // 只取最后一轮（最新）带附件的消息
  const lastMsg = messagesWithAttachments[messagesWithAttachments.length - 1];
  if (!lastMsg.attachments) return null;

  const lines: string[] = [];
  lines.push('[Attached Files]');
  lines.push('');

  for (const att of lastMsg.attachments) {
    // 图片附件由 Provider 层以多模态 content block 注入，此处不处理
    if (att.type === 'image') continue;

    if (isTextFile(att.mimeType, att.name)) {
      try {
        let content = await fs.readFile(att.path, 'utf8');
        if (content.length > MAX_ATTACHMENT_CONTENT_CHARS) {
          content = content.slice(0, MAX_ATTACHMENT_CONTENT_CHARS) +
            `\n\n[... 文件过长，已截断。使用 read_file 工具读取完整内容，路径: ${att.path}]`;
        }
        lines.push(`### ${att.name} (path: ${att.path})`);
        lines.push('');
        lines.push(content);
        lines.push('');
      } catch {
        lines.push(`### ${att.name} (path: ${att.path})`);
        lines.push(`[无法直接读取文件内容，使用 read_file 工具读取，路径: ${att.path}]`);
        lines.push('');
      }
    } else {
      lines.push(`### ${att.name} (path: ${att.path}, type: ${att.mimeType})`);
      lines.push(`[非文本文件，使用 read_file 工具读取，路径: ${att.path}]`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Agent 主循环（ReAct 工具调用循环）。
 *
 * 每轮调用 LLM：若模型请求工具，则执行并把结果作为 role:'tool' 消息回灌，再次请求；
 * 直到模型给出最终答案、达到最大轮次或被取消。
 * 含防死循环（指纹去重）、重试（指数退避）、取消（AbortController）与每轮持久化。
 */
export async function runTask(task: Task): Promise<void> {
  await runPiTask(task, agentLoopInternals);
}

// ---------------- 内部辅助 ----------------


function resumePlanFromCheckpoint(plan: PlanStep[], checkpointStepId?: string): PlanStep[] {
  if (plan.length === 0) return plan;
  if (!checkpointStepId) {
    return plan.map((step, index) => ({
      ...step,
      status: step.status === 'completed' ? 'completed' : index === 0 ? 'running' : 'pending',
    }));
  }
  const checkpointIndex = plan.findIndex((step) => step.id === checkpointStepId);
  return plan.map((step, index) => {
    if (index <= checkpointIndex) return { ...step, status: 'completed' };
    return { ...step, status: index === checkpointIndex + 1 ? 'running' : 'pending' };
  });
}

function finishCompleted(
  task: Task,
  updateStep: (d: string, s: PlanStep['status']) => void,
  saveFull: () => void,
): void {
  task.status = 'completed';
  task.phase = 'finalizing';
  task.plan = task.plan.map((step) =>
    step.status === 'completed' ? step : { ...step, status: 'completed' },
  );
  updateStep('任务完成', 'completed');
  saveFull();
  writeTrace(task.id, 'done', 'finalizing', { ok: true, summary: '任务完成' });
  taskEvents.publish({ type: 'status', taskId: task.id, status: 'completed' });
  taskEvents.publish({ type: 'phase', taskId: task.id, phase: 'finalizing', detail: '任务完成' });
  taskEvents.publish({ type: 'done', taskId: task.id, status: 'completed' });

  // M8: 任务完成后触发一轮 Dreams 后台维护（fire-and-forget）
  void import('../memory/dreams.js').then(({ runDreams }) => runDreams());
}

function finishCancelled(
  task: Task,
  updateStep: (d: string, s: PlanStep['status']) => void,
  saveFull: () => void,
): void {
  task.status = 'cancelled';
  task.phase = 'cancelled';
  task.plan = task.plan.map((step) =>
    step.status === 'completed' ? step : { ...step, status: 'cancelled' },
  );
  updateStep('任务已取消', 'cancelled');
  saveFull();
  writeTrace(task.id, 'done', 'cancelled', {
    ok: false,
    errorCategory: 'cancelled',
    summary: '任务已取消',
  });
  taskEvents.publish({ type: 'status', taskId: task.id, status: 'cancelled' });
  taskEvents.publish({ type: 'phase', taskId: task.id, phase: 'cancelled', detail: '用户取消任务' });
  taskEvents.publish({ type: 'done', taskId: task.id, status: 'cancelled' });
}

async function handleToolSideEffects(
  task: Task,
  call: ToolCall,
  result: ToolResult,
  workspaceDir: string,
  externalPaths?: string[],
): Promise<ToolResult> {
  if (!result.ok) return result;
  if (call.toolName === 'create_artifact' || call.toolName === 'apply_artifact') {
    const output = result.output as { artifactId?: unknown; path?: unknown } | undefined;
    const artifactId = typeof output?.artifactId === 'string' ? output.artifactId : undefined;
    const path = typeof output?.path === 'string' ? output.path : undefined;
    if (artifactId && path) {
      const artifact = markArtifactApplied(task, artifactId, path);
      if (artifact) taskEvents.publish({ type: 'artifact_updated', taskId: task.id, artifact });
    }
  }
  if (call.toolName === 'attach_content') {
    const blockData = extractContentBlockData(result.output);
    if (blockData) {
      const block: ContentBlock = {
        id: randomUUID(),
        type: blockData.type,
        content: await normalizeContentBlockPath(blockData, workspaceDir, externalPaths),
        name: blockData.name,
        mimeType: blockData.mimeType,
        size: blockData.size,
      };
      // 找到最近一条 assistant 消息并附加 content block
      const assistantMsg = [...task.messages].reverse().find(m => m.role === 'assistant');
      if (assistantMsg) {
        assistantMsg.contentBlocks = [...(assistantMsg.contentBlocks ?? []), block];
        taskEvents.publish({
          type: 'content_blocks_added',
          taskId: task.id,
          messageId: assistantMsg.id,
          blocks: [block],
        });
      }
      return { callId: call.id, ok: true, output: { ok: true, block } };
    }
    return { callId: call.id, ok: false, error: 'attach_content 返回格式非法' };
  }
  return result;
}

async function normalizeContentBlockPath(
  block: { type: ContentBlockType; content: string },
  workspaceDir: string,
  externalPaths?: string[],
): Promise<string> {
  if (block.type === 'link') return block.content;
  if (looksLikeRemoteUrl(block.content)) return block.content;

  try {
    const rawPath = block.content.startsWith('file://')
      ? fileURLToPath(block.content)
      : block.content;
    const resolved = resolveInWorkspace(rawPath, workspaceDir, externalPaths);
    await assertRealPathInside(resolved, workspaceDir, externalPaths);
    await fs.stat(resolved);
    return resolved;
  } catch {
    return block.content;
  }
}

function looksLikeRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function extractContentBlockData(output: unknown): {
  type: ContentBlockType;
  content: string;
  name?: string;
  mimeType?: string;
  size?: number;
} | null {
  if (!output || typeof output !== 'object') return null;
  const data = (output as { contentBlock?: unknown }).contentBlock;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (typeof record.type !== 'string' || typeof record.content !== 'string') return null;
  if (!['file_reference', 'image', 'link'].includes(record.type)) return null;
  return {
    type: record.type as ContentBlockType,
    content: record.content,
    name: typeof record.name === 'string' ? record.name : undefined,
    mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
    size: typeof record.size === 'number' ? record.size : undefined,
  };
}

function writeToolCallTrace(
  taskId: string,
  call: ToolCall,
  riskLevel: ToolRiskLevel,
  iteration: number,
): void {
  writeTrace(taskId, 'tool_call', 'calling_tool', {
    iteration,
    callId: call.id,
    toolName: call.toolName,
    riskLevel,
    ok: true,
    summary: `请求工具：${call.toolName}`,
    data: { args: summarizePayload(call.args) },
  });
}

function writeApprovalTrace(
  taskId: string,
  call: ToolCall,
  riskLevel: ToolRiskLevel,
  approved: boolean,
  iteration: number,
): void {
  writeTrace(taskId, 'approval', 'waiting_approval', {
    iteration,
    callId: call.id,
    toolName: call.toolName,
    riskLevel,
    ok: approved,
    errorCategory: approved ? undefined : 'permission',
    errorMessage: approved ? undefined : '用户拒绝或审批超时',
    summary: approved ? `审批通过：${call.toolName}` : `审批未通过：${call.toolName}`,
  });
}

function classifyError(err: unknown): TaskErrorCategory {
  if (err instanceof BudgetExceededError) return 'timeout';
  const name = (err as { name?: string })?.name;
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError') return 'cancelled';
  if (name === 'TimeoutError' || /timeout|timed out|超时/i.test(message)) return 'timeout';
  if (/未配置|Provider|API Key|配置/i.test(message)) return 'configuration';
  if (/JSON|parse|解析/i.test(message)) return 'parse';
  if (typeof status === 'number') return status >= 400 && status < 500 ? 'configuration' : 'model';
  if (/工具|tool/i.test(message)) return 'tool';
  return 'unknown';
}

function summarizePayload(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text || text.length <= 1200) return value;
  return {
    truncated: true,
    chars: text.length,
    preview: text.slice(0, 1200),
  };
}

function estimatePayloadBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null));
  } catch {
    return Buffer.byteLength(String(value));
  }
}

function makeAssistant(content: string, reasoningContent: string): Message {
  const msg: Message = {
    id: randomUUID(),
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
  };
  if (reasoningContent) msg.reasoningContent = reasoningContent;
  return msg;
}

function makeAssistantWithToolCalls(
  content: string,
  reasoningContent: string,
  toolCalls: AccumulatedToolCall[],
  planStepIdByCallId?: ReadonlyMap<string, string>,
): Message {
  const msg = makeAssistant(content, reasoningContent);
  msg.toolCalls = toolCalls.map(
    (tc): MessageToolCall => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments, planStepId: planStepIdByCallId?.get(tc.id) } as MessageToolCall['function'],
    }),
  );
  return msg;
}

function makeToolResult(toolCallId: string, payload: unknown): Message {
  return {
    id: randomUUID(),
    role: 'tool',
    content: JSON.stringify(payload ?? null),
    toolCallId,
    createdAt: new Date().toISOString(),
  };
}

function patchDanglingToolResults(messages: Message[]): number {
  let patched = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;

    const existing = new Set<string>();
    let insertAt = i + 1;
    while (insertAt < messages.length && messages[insertAt].role === 'tool') {
      const toolCallId = messages[insertAt].toolCallId;
      if (toolCallId) existing.add(toolCallId);
      insertAt += 1;
    }

    const missing = message.toolCalls.filter((toolCall) => !existing.has(toolCall.id));
    if (missing.length === 0) continue;

    const results = missing.map((toolCall) =>
      makeToolResult(toolCall.id, {
        error: '上次执行在该工具返回前中断；恢复任务时已关闭这次悬空工具调用，请重新规划或改用其他方式。',
      }),
    );
    messages.splice(insertAt, 0, ...results);
    patched += results.length;
    i = insertAt + results.length - 1;
  }
  return patched;
}

// ---- 内部辅助 ----

type TracePatch = Partial<
  Pick<
    TaskTraceEntry,
    | 'iteration'
    | 'callId'
    | 'toolName'
    | 'riskLevel'
    | 'finishReason'
    | 'ok'
    | 'errorCategory'
    | 'errorMessage'
    | 'summary'
    | 'data'
    | 'tokenUsage'
  >
> & {
  startedAtMs?: number;
};

function writeTrace(
  taskId: string,
  kind: TaskTraceEntry['kind'],
  phase: TaskPhase | null,
  patch: TracePatch = {},
): void {
  const taskLog = createTaskLogger(taskId);
  const endedAtMs = Date.now();
  const startedAtMs = patch.startedAtMs ?? endedAtMs;
  taskLog.trace(kind, phase, {
    iteration: patch.iteration,
    callId: patch.callId,
    toolName: patch.toolName,
    riskLevel: patch.riskLevel,
    finishReason: patch.finishReason,
    tokenUsage: patch.tokenUsage ?? null,
    startedAtMs,
    ok: patch.ok,
    errorCategory: patch.errorCategory,
    errorMessage: patch.errorMessage,
    summary: patch.summary,
    data: patch.data,
  });
}
