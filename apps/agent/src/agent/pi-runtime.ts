import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  AgentEvent as PiAgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
} from '@earendil-works/pi-agent-core';
import { runAgentLoopContinue } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context as PiLlmContext,
  type Message as PiMessage,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall as PiToolCall,
  type Usage,
} from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type {
  AgentEvent,
  AggregatedTokenUsage,
  AutoModeLevel,
  FileSnapshot,
  Message,
  MessageToolCall,
  PlanStep,
  Task,
  TaskErrorCategory,
  TaskPhase,
  TaskStatus,
  TokenUsage,
  ToolCall,
  ToolResult,
  ToolRiskLevel,
} from '@aurevoy/shared';
import { taskEvents } from './events.js';
import { getProvider, type AccumulatedToolCall } from '../llm/provider.js';
import { compactContext, buildMemorySystemMessage, buildSkillCatalogMessage, buildSystemContextMessage, buildToolGuidanceMessage, totalTokens } from './context.js';
import { toolRegistry } from '../tools/registry.js';
import { taskStore, memoryStore, projectStore } from '../store/db.js';
import { config } from '../config.js';
import { runPlanAgent } from './plan-agent.js';
import { withRetry } from './retry.js';
import {
  assertBudgetWithinLimits,
  BudgetExceededError,
  createCheckpoint,
  createClarification,
  effectiveBudget,
  initialBudgetUsage,
  resolveClarification,
  updateWallTime,
} from './m6-state.js';

type RuntimeInternals = {
  activeAbortControllers: Map<string, AbortController>;
  waitForApproval(taskId: string, callId: string, signal: AbortSignal): Promise<{
    approved: boolean;
    sessionApprove?: boolean;
    prefixKey?: string;
  }>;
  approvalKeyForCall(call: ToolCall): string;
  prefixApprovalKeyForCall(call: ToolCall): string;
  isApprovalFreeTool(toolName: string): boolean;
  autoModeApprovalReason(
    level: AutoModeLevel,
    paused: boolean,
    toolName: string,
  ): 'not_covered' | 'paused' | undefined;
  addPendingApproval(
    task: Task,
    call: ToolCall,
    riskLevel: ToolRiskLevel,
    autoModeReason?: 'blocked_by_rule' | 'not_covered' | 'paused',
  ): void;
  removePendingApproval(task: Task, callId: string): void;
  rememberSessionApproval(task: Task, key: string): void;
  waitForClarification(taskId: string, clarificationId: string, signal: AbortSignal): Promise<string | null>;
  waitForPlanApproval(taskId: string, signal: AbortSignal): Promise<{ approved: boolean; reason?: string }>;
  getEffectiveAutoModeLevel(task: Task): AutoModeLevel;
  initAutoModeState(level: AutoModeLevel, preMode?: AutoModeLevel): NonNullable<Task['autoModeState']>;
  shouldAutoPlan(goal: string): boolean;
  buildModeSystemMessage(level: AutoModeLevel): Message | null;
  resolveTaskWorkspace(task: Task): Promise<string>;
  collectExternalPaths(task: Task): string[];
  buildAttachmentSystemMessage(task: Task): Promise<string | null>;
  captureFileSnapshot(filePath: string, taskId: string, workspaceDir: string): Promise<string | null>;
  handleToolSideEffects(
    task: Task,
    call: ToolCall,
    result: ToolResult,
    workspaceDir: string,
    externalPaths?: string[],
  ): Promise<ToolResult>;
  classifyError(err: unknown): TaskErrorCategory;
  summarizePayload(value: unknown): unknown;
  estimatePayloadBytes(value: unknown): number;
  writeTrace(
    taskId: string,
    kind: Parameters<typeof import('../logging/trace.js')['createTaskLogger']>[0] extends never ? never : any,
    phase: TaskPhase | null,
    patch?: Record<string, unknown>,
  ): void;
  writeToolCallTrace(taskId: string, call: ToolCall, riskLevel: ToolRiskLevel, iteration: number): void;
  writeApprovalTrace(taskId: string, call: ToolCall, riskLevel: ToolRiskLevel, approved: boolean, iteration: number): void;
  finishCompleted(task: Task, updateStep: (d: string, s: PlanStep['status']) => void, saveFull: () => void): void;
  finishCancelled(task: Task, updateStep: (d: string, s: PlanStep['status']) => void, saveFull: () => void): void;
  makeAssistant(content: string, reasoningContent: string): Message;
  makeAssistantWithToolCalls(
    content: string,
    reasoningContent: string,
    toolCalls: AccumulatedToolCall[],
    planStepIdByCallId?: ReadonlyMap<string, string>,
  ): Message;
  makeToolResult(toolCallId: string, payload: unknown): Message;
};

const PLANMODE_TOOLS = new Set([
  'list_directory', 'glob', 'get_current_time', 'load_skill',
  'open_file', 'scroll', 'search_grep',
]);

const AUTO_EDIT_TOOLS = new Set([
  ...PLANMODE_TOOLS,
  'apply_artifact', 'move_file', 'copy_file', 'rename_file',
  'create_file', 'write_file', 'edit_lines', 'append_file',
  'session_open', 'session_write', 'session_close',
  'create_artifact',
]);

const WRITE_TOOLS = new Set([
  'apply_artifact', 'create_artifact', 'copy_file', 'move_file', 'rename_file',
  'create_file', 'write_file', 'edit_lines', 'append_file',
  'session_open', 'session_write', 'session_close',
]);

const TOOL_ALIASES = new Map<string, string>([
  ['read_file', 'read'],
  ['http_fetch', 'web_fetch'],
  ['search_files', 'search_grep'],
]);

const MAX_TOOL_CALLS_PER_TURN = 10;
const DUPLICATE_CALL_LIMIT = 3;
const AUTO_MODE_MAX_CONSECUTIVE = 50;
const AUREVOY_SYSTEM_MESSAGE_ROLE = 'aurevoySystem';

interface PiRunState {
  task: Task;
  internals: RuntimeInternals;
  abortController: AbortController;
  taskWorkspace: string;
  externalPaths: string[];
  startedAtMs: number;
  activeStepIndex: number;
  currentIteration: number;
  currentAutoModeLevel: AutoModeLevel;
  currentAutoModePaused: boolean;
  planStepIdByCallId: Map<string, string>;
  pendingToolCallById: Map<string, ToolCall>;
  pendingRiskById: Map<string, ToolRiskLevel>;
  callFingerprints: Map<string, number>;
  lastCachedIndex: number;
  attachmentSystemMessage: Message | null;
}

export async function runPiTask(task: Task, internals: RuntimeInternals): Promise<void> {
  task.pendingApprovals = [];
  taskStore.save(task);

  const abortController = new AbortController();
  internals.activeAbortControllers.set(task.id, abortController);
  const taskStartedAtMs = Date.now();
  const taskWorkspace = await internals.resolveTaskWorkspace(task);
  const externalPaths = internals.collectExternalPaths(task);

  const touch = () => {
    task.updatedAt = new Date().toISOString();
    taskStore.patch(task.id, {
      status: task.status,
      phase: task.phase,
      budgetUsage: task.budgetUsage,
      tokenUsage: task.tokenUsage,
      contextTokens: task.contextTokens,
      pendingApprovals: task.pendingApprovals,
      approvedApprovalKeys: task.approvedApprovalKeys,
    });
  };
  const saveFull = () => {
    task.updatedAt = new Date().toISOString();
    taskStore.save(task);
  };

  let activeStepIndex = task.plan.findIndex((step) => step.status === 'running');
  if (activeStepIndex < 0) activeStepIndex = 0;

  const updateStep = (description: string, status: PlanStep['status']) => {
    const index = Math.max(0, Math.min(activeStepIndex, task.plan.length - 1));
    const step = task.plan[index] ?? { id: 'exec', description, status };
    const next = { ...step, description, status };
    task.plan[index] = next;
    touch();
    taskEvents.publish({ type: 'step_update', taskId: task.id, step: { ...next } });
  };

  const completeCurrentStep = (label: string, data?: unknown) => {
    const current = task.plan[activeStepIndex];
    if (!current) return;
    let completedStep: PlanStep | null = null;
    if (current.status !== 'completed') {
      task.plan[activeStepIndex] = { ...current, status: 'completed' };
      completedStep = task.plan[activeStepIndex];
    }
    const checkpoint = createCheckpoint({
      label,
      stepId: current.id,
      message: `完成步骤：${current.description}`,
      data,
    });
    task.checkpoints = [...(task.checkpoints ?? []), checkpoint];
    let nextStep: PlanStep | null = null;
    if (activeStepIndex < task.plan.length - 1) {
      activeStepIndex += 1;
      task.plan[activeStepIndex] = { ...task.plan[activeStepIndex], status: 'running' };
      nextStep = task.plan[activeStepIndex];
    }
    saveFull();
    if (completedStep) taskEvents.publish({ type: 'step_update', taskId: task.id, step: completedStep });
    taskEvents.publish({ type: 'checkpoint_created', taskId: task.id, checkpoint });
    if (nextStep) taskEvents.publish({ type: 'step_update', taskId: task.id, step: nextStep });
  };

  const setRuntimePhase = (phase: TaskPhase, detail?: string, status?: TaskStatus) => {
    if (status && task.status !== status) {
      task.status = status;
      taskEvents.publish({ type: 'status', taskId: task.id, status });
    }
    task.phase = phase;
    touch();
    internals.writeTrace(task.id, 'phase', phase, { ok: true, summary: detail });
    taskEvents.publish({ type: 'phase', taskId: task.id, phase, detail });
  };

  try {
    await ensurePlan(task, internals, abortController, taskWorkspace, externalPaths, setRuntimePhase, touch, saveFull, updateStep);
    if (abortController.signal.aborted) return internals.finishCancelled(task, updateStep, saveFull);

    const attachmentContext = await internals.buildAttachmentSystemMessage(task);
    const state: PiRunState = {
      task,
      internals,
      abortController,
      taskWorkspace,
      externalPaths,
      startedAtMs: taskStartedAtMs,
      activeStepIndex,
      currentIteration: 0,
      currentAutoModeLevel: internals.getEffectiveAutoModeLevel(task),
      currentAutoModePaused: !!task.autoModeState?.paused,
      planStepIdByCallId: new Map(),
      pendingToolCallById: new Map(),
      pendingRiskById: new Map(),
      callFingerprints: new Map(),
      lastCachedIndex: 0,
      attachmentSystemMessage: attachmentContext
        ? { id: `att-${randomUUID()}`, role: 'system', content: attachmentContext, createdAt: new Date().toISOString() }
        : null,
    };

    setRuntimePhase('initializing', '准备运行 Pi Agent', 'running');
    taskEvents.publish({ type: 'plan', taskId: task.id, plan: task.plan });

    const context = await buildPiContext(state);
    const newMessages = await runAgentLoopContinue(
      context,
      {
        model: makeAurevoyPiModel(),
        convertToLlm: convertPiMessagesToLlm,
        transformContext: async (messages, signal) => transformPiContext(state, messages, signal),
        beforeToolCall: async (ctx, signal) => beforePiToolCall(state, ctx, signal),
        afterToolCall: async (ctx) => afterPiToolCall(state, ctx),
        prepareNextTurn: async (ctx) => prepareNextPiTurn(state, ctx),
        toolExecution: 'parallel',
      },
      async (event) => handlePiEvent(state, event),
      abortController.signal,
      (model, llmContext, options) => aurevoyStreamFn(state, model, llmContext, options),
    );

    for (const message of newMessages) {
      const converted = fromPiMessage(message, state);
      if (converted && !hasEquivalentMessage(task.messages, converted)) task.messages.push(converted);
    }
    saveFull();

    if (abortController.signal.aborted) return internals.finishCancelled(task, updateStep, saveFull);

    const failedAssistant = [...newMessages]
      .reverse()
      .find((message): message is AssistantMessage =>
        isRecord(message) &&
        message.role === 'assistant' &&
        ((message as AssistantMessage).stopReason === 'error' || (message as AssistantMessage).stopReason === 'aborted'),
      );
    if (failedAssistant) {
      throw new Error(failedAssistant.errorMessage ?? 'Pi Agent 模型调用失败');
    }

    const lastAssistant = [...task.messages].reverse().find((m) => m.role === 'assistant');
    const currentMode = internals.getEffectiveAutoModeLevel(task);
    if (currentMode === 'plan' && task.autoModeState && !task.autoModeState.planReady && lastAssistant) {
      await handlePlanModeFinalReply(task, internals, abortController, lastAssistant, setRuntimePhase, touch, saveFull, updateStep);
      return;
    }

    return internals.finishCompleted(task, updateStep, saveFull);
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      return internals.finishCancelled(task, updateStep, saveFull);
    }
    task.status = err instanceof BudgetExceededError ? 'failed' : 'failed';
    task.phase = 'failed';
    updateStep('任务失败', 'failed');
    saveFull();
    const message = err instanceof Error ? err.message : String(err);
    internals.writeTrace(task.id, 'error', 'failed', {
      ok: false,
      errorCategory: internals.classifyError(err),
      errorMessage: message,
      summary: 'Pi Agent 任务失败',
    });
    taskEvents.publish({ type: 'status', taskId: task.id, status: 'failed' });
    taskEvents.publish({ type: 'phase', taskId: task.id, phase: 'failed', detail: message });
    taskEvents.publish({ type: 'error', taskId: task.id, message });
    taskEvents.publish({ type: 'done', taskId: task.id, status: 'failed' });
  } finally {
    internals.activeAbortControllers.delete(task.id);
  }

  function syncActiveStepIndex(): void {
    activeStepIndex = stateSafeActiveStepIndex(task, activeStepIndex);
  }

  async function afterPiToolCall(state: PiRunState, ctx: Parameters<NonNullable<import('@earendil-works/pi-agent-core').AgentLoopConfig['afterToolCall']>>[0]) {
    syncActiveStepIndex();
    const call = state.pendingToolCallById.get(ctx.toolCall.id);
    if (!call) return undefined;
    const risk = state.pendingRiskById.get(call.id) ?? riskLevelOfCall(call.toolName);
    const result = piToolResultToAurevoy(call, ctx.result, ctx.isError);
    if (!result.ok && call.toolName === 'read_file' && result.error && !/schema/i.test(result.error)) {
      result.error = `schema validation failed: ${result.error}`;
    }
    const enriched = await internals.handleToolSideEffects(task, call, result, taskWorkspace, externalPaths);
    task.budgetUsage = task.budgetUsage ?? initialBudgetUsage();
    task.budgetUsage.outputBytes += internals.estimatePayloadBytes(enriched.output ?? enriched.error ?? '');
    assertBudgetWithinLimits(task);
    taskEvents.publish({ type: 'tool_result', taskId: task.id, result: enriched });
    internals.writeTrace(task.id, 'tool_result', 'calling_tool', {
      iteration: state.currentIteration,
      callId: call.id,
      toolName: call.toolName,
      riskLevel: risk,
      ok: enriched.ok,
      errorCategory: enriched.ok ? undefined : 'tool',
      errorMessage: enriched.error,
      summary: enriched.ok ? `工具成功：${call.toolName}` : `工具失败：${call.toolName}`,
      data: enriched.ok ? { output: internals.summarizePayload(enriched.output) } : undefined,
    });
    if (enriched.ok) {
      completeCurrentStep(`工具完成：${call.toolName}`, {
        toolName: call.toolName,
        callId: call.id,
        output: internals.summarizePayload(enriched.output),
      });
    }
    touch();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(enriched.ok ? enriched.output : { error: enriched.error }) }],
      details: enriched,
      isError: !enriched.ok,
    };
  }
}

async function ensurePlan(
  task: Task,
  internals: RuntimeInternals,
  abortController: AbortController,
  taskWorkspace: string,
  externalPaths: string[],
  setRuntimePhase: (phase: TaskPhase, detail?: string, status?: TaskStatus) => void,
  touch: () => void,
  saveFull: () => void,
  updateStep: (d: string, s: PlanStep['status']) => void,
): Promise<void> {
  const hasApprovedPlan = task.plan.length > 1 && task.plan.some((s) => s.status === 'running');
  if (hasApprovedPlan) return;

  const prePlanMode = internals.getEffectiveAutoModeLevel(task);
  if ((prePlanMode === 'auto-edit' || prePlanMode === 'full') && !task.autoModeState?.paused && internals.shouldAutoPlan(task.goal)) {
    task.autoModeState = task.autoModeState ?? internals.initAutoModeState(prePlanMode);
    task.autoModeState.level = 'plan';
    task.autoModeState.planReady = false;
    task.autoModeState.planPreMode = prePlanMode;
    touch();
    internals.writeTrace(task.id, 'phase', 'planning', {
      ok: true,
      summary: '检测到复杂任务，自动切入 Plan Mode',
      data: { goal: task.goal, previousMode: prePlanMode },
    });
  }

  if (task.planMode !== 'manual') {
    const heuristicSteps = inferHeuristicPlan(task.goal);
    task.plan = heuristicSteps.length > 0
      ? heuristicSteps.map((description, index) => ({
          id: `step-${index + 1}`,
          description,
          status: index === 0 ? 'running' : 'pending',
          source: 'heuristic',
        }))
      : [{ id: 'exec', description: '执行任务', status: 'running' }];
    taskEvents.publish({ type: 'plan_generated', taskId: task.id, plan: task.plan, source: 'heuristic' });
    touch();
    return;
  }

  setRuntimePhase('planning', '用户通过 /plan 请求生成执行计划…', 'planning');
  const planOutput = await runPlanAgent({
    taskId: task.id,
    goal: task.goal,
    workspaceDir: taskWorkspace,
    externalPaths,
    signal: abortController.signal,
  });
  if (abortController.signal.aborted) {
    updateStep('任务已取消', 'cancelled');
    return;
  }

  const proposedPlan: PlanStep[] = planOutput.steps.map((step, index) => ({
    id: `step-${index + 1}`,
    description: step.description,
    status: 'proposed',
    toolsExpected: step.toolsExpected,
    dependsOn: step.dependsOn,
    verifiable: step.verifiable,
    source: planOutput.source,
  }));
  task.plan = proposedPlan;
  saveFull();
  taskEvents.publish({ type: 'plan_generated', taskId: task.id, plan: proposedPlan, source: planOutput.source });
  taskEvents.publish({
    type: 'plan_approval_request',
    taskId: task.id,
    plan: proposedPlan,
    reasoning: `Plan Agent（${planOutput.source}）生成 ${proposedPlan.length} 步计划，预估 ${planOutput.estimatedIterations} 轮`,
    scoutReport: planOutput.scoutReport,
  });

  const effectiveMode = internals.getEffectiveAutoModeLevel(task);
  if (effectiveMode !== 'off' && !task.autoModeState?.paused) {
    task.plan = proposedPlan.map((step, index) => ({ ...step, status: index === 0 ? 'running' : 'pending' }));
    taskEvents.publish({ type: 'plan_approval_resolved', taskId: task.id, approved: true });
    touch();
    return;
  }

  setRuntimePhase('waiting_approval', '等待审批执行计划…', 'paused');
  const decision = await internals.waitForPlanApproval(task.id, abortController.signal);
  if (decision.approved) {
    task.plan = proposedPlan.map((step, index) => ({ ...step, status: index === 0 ? 'running' : 'pending' }));
    taskEvents.publish({ type: 'plan_approval_resolved', taskId: task.id, approved: true });
  } else {
    task.plan = [{
      id: 'exec',
      description: decision.reason
        ? `用户拒绝了计划（原因：${decision.reason}），直接执行任务`
        : '用户拒绝了计划，直接执行任务',
      status: 'running',
    }];
    taskEvents.publish({ type: 'plan_approval_resolved', taskId: task.id, approved: false, reason: decision.reason });
  }
  touch();
}

function inferHeuristicPlan(goal: string): string[] {
  const text = goal.toLowerCase();
  const steps: string[] = [];
  if (/(整理|总结|summary|report|材料|资料|文件|docs?|markdown|md|todo|搜索|search)/i.test(goal)) {
    steps.push('扫描工作区材料');
    steps.push('阅读与提取关键信息');
  }
  if (/(网页|url|http|fetch|抓取|网站|页面)/i.test(goal)) {
    steps.push('抓取并清洗网页来源');
    steps.push('提取网页正文与链接');
  }
  if (/(运行|执行|命令|typecheck|build|test|npm|脚本|command)/i.test(goal)) {
    steps.push('确认命令执行边界');
    steps.push('运行命令并收集输出');
  }
  if (/(生成|写入|保存|artifact|报告|summary|markdown|md|翻译|输出)/i.test(goal)) {
    steps.push('生成可预览产物');
    steps.push('确认后保存结果');
  }
  const unique = [...new Set(steps)];
  if (unique.length < 2 || !text.trim()) return [];
  unique.push('汇总结果并说明后续建议');
  return unique.slice(0, 6);
}

async function buildPiContext(state: PiRunState): Promise<import('@earendil-works/pi-agent-core').AgentContext> {
  const messages = state.task.messages.map(toPiMessage).filter((m): m is AgentMessage => m !== null);
  return {
    systemPrompt: 'You are Aurevoy, a general-purpose desktop AI agent.',
    messages,
    tools: buildPiTools(state),
  };
}

async function transformPiContext(
  state: PiRunState,
  piMessages: AgentMessage[],
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  if (signal?.aborted) return piMessages;
  state.task.budgetUsage = state.task.budgetUsage ?? initialBudgetUsage();
  state.task.budgetUsage.iterations = state.currentIteration;
  updateWallTime(state.task, state.startedAtMs);
  assertBudgetWithinLimits(state.task);
  state.task.budgetUsage.iterations = state.currentIteration + 1;
  taskEvents.publish({
    type: 'budget_usage',
    taskId: state.task.id,
    usage: state.task.budgetUsage,
    budget: effectiveBudget(state.task),
  });

  state.currentIteration += 1;
  state.currentAutoModeLevel = state.internals.getEffectiveAutoModeLevel(state.task);
  state.currentAutoModePaused = !!state.task.autoModeState?.paused;
  setTaskPhase(state, 'thinking', `第 ${state.currentIteration} 轮 Pi Agent 思考`, 'running');

  const aurevoyMessages = piMessages.map(fromPiMessageLoose).filter((m): m is Message => m !== null);
  const compactResult = await compactContext(aurevoyMessages, state.lastCachedIndex);
  if (compactResult.collapsed) state.lastCachedIndex = 0;
  if (compactResult.collapsed || compactResult.stats.snipped > 0 || compactResult.stats.microcompacted > 0) {
    state.internals.writeTrace(state.task.id, 'phase', 'thinking', {
      iteration: state.currentIteration,
      ok: true,
      summary: `上下文压缩：Snip ${compactResult.stats.snipped} 条空结果，Microcompact ${compactResult.stats.microcompacted} 条工具输出，释放 ~${compactResult.stats.savedTokens} tokens`,
      data: compactResult.stats,
    });
  }

  const recentTopics = state.task.messages
    .filter((m) => m.role === 'user')
    .slice(-3)
    .map((m) => m.content);
  const { message: memoryMessage } = await buildMemorySystemMessage(memoryStore.listEnabled(), state.task.goal, recentTopics);
  const skillCatalogMessage = buildSkillCatalogMessage();
  const projectInfo = state.task.projectId ? projectStore.get(state.task.projectId) : undefined;
  const envContextMessage = buildSystemContextMessage(
    state.taskWorkspace,
    dirname(config.dbPath),
    projectInfo ? { name: projectInfo.name, path: projectInfo.path } : undefined,
  );
  const modeMessage = state.currentAutoModePaused ? null : state.internals.buildModeSystemMessage(state.currentAutoModeLevel);
  const toolGuidanceMessage = buildToolGuidanceMessage();
  const requestMessages = [
    envContextMessage,
    toolGuidanceMessage,
    modeMessage,
    memoryMessage,
    skillCatalogMessage,
    state.attachmentSystemMessage,
    ...compactResult.messages,
  ].filter(Boolean) as Message[];

  const contextTokenEstimate = totalTokens(requestMessages);
  state.task.contextTokens = contextTokenEstimate;
  taskEvents.publish({ type: 'context_snapshot', taskId: state.task.id, tokens: contextTokenEstimate });
  state.lastCachedIndex = piMessages.length;
  taskStore.patch(state.task.id, {
    phase: state.task.phase,
    status: state.task.status,
    budgetUsage: state.task.budgetUsage,
    contextTokens: state.task.contextTokens,
  });

  const nonSystemMessages = requestMessages
    .filter((message) => message.role !== 'system')
    .map(toPiMessage)
    .filter((m): m is AgentMessage => m !== null);
  return [
    ...requestMessages
      .filter((message) => message.role === 'system')
      .map((message) => ({
        role: AUREVOY_SYSTEM_MESSAGE_ROLE,
        content: message.content,
        timestamp: Date.parse(message.createdAt),
      } as unknown as AgentMessage)),
    ...nonSystemMessages,
  ];
}

async function beforePiToolCall(
  state: PiRunState,
  ctx: BeforeToolCallContext,
  signal?: AbortSignal,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const toolCall = ctx.toolCall;
  const call: ToolCall = {
    id: toolCall.id,
    toolName: toolCall.name,
    args: isRecord(ctx.args) ? ctx.args : {},
  };
  state.pendingToolCallById.set(call.id, call);
  const risk = riskLevelOfCall(call.toolName);
  state.pendingRiskById.set(call.id, risk);

  const fingerprint = `${call.toolName}:${JSON.stringify(call.args)}`;
  const count = (state.callFingerprints.get(fingerprint) ?? 0) + 1;
  state.callFingerprints.set(fingerprint, count);
  if (count > DUPLICATE_CALL_LIMIT) {
    return { block: true, reason: `工具 "${call.toolName}" 已用相同参数被调用 ${count} 次。请换一种方式，或直接给出最终答案。` };
  }
  if (state.currentAutoModeLevel === 'plan' && !PLANMODE_TOOLS.has(call.toolName)) {
    return { block: true, reason: `工具 "${call.toolName}" 在 Plan Mode 中不可用。请先输出计划并等待审批。` };
  }

  state.activeStepIndex = stateSafeActiveStepIndex(state.task, state.activeStepIndex);
  if (state.task.plan[state.activeStepIndex]?.id) {
    (call as ToolCall & { planStepId?: string }).planStepId = state.task.plan[state.activeStepIndex].id;
    state.planStepIdByCallId.set(call.id, state.task.plan[state.activeStepIndex].id);
  }

  taskEvents.publish({ type: 'tool_call', taskId: state.task.id, call });
  state.internals.writeToolCallTrace(state.task.id, call, risk, state.currentIteration);
  state.task.budgetUsage = state.task.budgetUsage ?? initialBudgetUsage();
  state.task.budgetUsage.toolCalls += 1;
  updateWallTime(state.task, state.startedAtMs);
  taskEvents.publish({
    type: 'budget_usage',
    taskId: state.task.id,
    usage: state.task.budgetUsage,
    budget: effectiveBudget(state.task),
  });
  assertBudgetWithinLimits(state.task);

  if (call.toolName === 'ask_user') {
    setTaskPhase(state, 'waiting_clarification', '等待用户补充信息', 'paused');
    const answerResult = await resolveAskUserAsTool(state, call, signal ?? state.abortController.signal);
    return {
      block: true,
      reason: JSON.stringify(answerResult.ok ? answerResult.output : { error: answerResult.error }),
    };
  }

  if (isAutoApproved(state, call)) {
    setTaskPhase(state, 'calling_tool', `执行：${call.toolName}`, 'running');
    if (WRITE_TOOLS.has(call.toolName) && typeof call.args.path === 'string') {
      await captureSnapshotForCall(state, call);
    }
    return undefined;
  }

  const approvalReason = state.internals.autoModeApprovalReason(state.currentAutoModeLevel, state.currentAutoModePaused, call.toolName);
  state.internals.addPendingApproval(state.task, call, risk, approvalReason);
  taskEvents.publish({ type: 'approval_request', taskId: state.task.id, call, riskLevel: risk, autoModeReason: approvalReason });
  setTaskPhase(state, 'waiting_approval', `等待确认：${call.toolName}`, 'paused');
  const result = await state.internals.waitForApproval(state.task.id, call.id, signal ?? state.abortController.signal);
  if (result.approved && result.sessionApprove) state.internals.rememberSessionApproval(state.task, state.internals.approvalKeyForCall(call));
  if (result.approved && result.prefixKey) state.internals.rememberSessionApproval(state.task, result.prefixKey);
  state.internals.removePendingApproval(state.task, call.id);
  state.internals.writeApprovalTrace(state.task.id, call, risk, result.approved, state.currentIteration);

  if (!result.approved) return { block: true, reason: '用户拒绝执行该工具。请改用其他方式，或直接给出最终答案。' };

  if (state.task.autoModeState?.consecutiveAutoCalls) {
    state.task.autoModeState.consecutiveAutoCalls = 0;
    taskStore.patch(state.task.id, { approvedApprovalKeys: state.task.approvedApprovalKeys });
  }
  setTaskPhase(state, 'calling_tool', `执行：${call.toolName}`, 'running');
  if (WRITE_TOOLS.has(call.toolName) && typeof call.args.path === 'string') {
    await captureSnapshotForCall(state, call);
  }
  return undefined;
}

function prepareNextPiTurn(
  state: PiRunState,
  _ctx: import('@earendil-works/pi-agent-core').PrepareNextTurnContext,
): undefined {
  const ams = state.task.autoModeState;
  if (ams && !ams.paused) {
    const autoThisTurn = [...state.pendingToolCallById.values()].filter((call) => isAutoApproved(state, call)).length;
    if (autoThisTurn > 0) {
      ams.autoApprovedCalls = (ams.autoApprovedCalls ?? 0) + autoThisTurn;
      ams.consecutiveAutoCalls = (ams.consecutiveAutoCalls ?? 0) + autoThisTurn;
      taskEvents.publish({ type: 'auto_mode_state', taskId: state.task.id, state: { ...ams } });
    }
    if (state.currentAutoModeLevel !== 'full' && (ams.consecutiveAutoCalls ?? 0) >= AUTO_MODE_MAX_CONSECUTIVE) {
      ams.paused = true;
      ams.pausedReason = `auto mode 已连续自动批准 ${ams.consecutiveAutoCalls} 次工具调用，已暂停。请确认继续运行。`;
      ams.fallbackCount = (ams.fallbackCount ?? 0) + 1;
      taskEvents.publish({ type: 'auto_mode_state', taskId: state.task.id, state: { ...ams } });
      taskEvents.publish({ type: 'phase', taskId: state.task.id, phase: 'waiting_approval', detail: ams.pausedReason });
      state.internals.writeTrace(state.task.id, 'phase', 'waiting_approval', {
        ok: true,
        summary: ams.pausedReason,
        data: { autoModeState: { ...ams } },
      });
    }
  }
  state.pendingToolCallById.clear();
  state.pendingRiskById.clear();
  return undefined;
}

function buildPiTools(state: PiRunState): AgentTool[] {
  const tools = toolRegistry.list().slice(0, MAX_TOOL_CALLS_PER_TURN * 20).map((descriptor): AgentTool => ({
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
    parameters: Type.Unsafe(descriptor.inputSchema) as TSchema,
    executionMode: executionPolicyOfCall(descriptor.name).parallelizable === false ? 'sequential' : 'parallel',
    execute: async (toolCallId, params, signal) => {
      const call: ToolCall = { id: toolCallId, toolName: descriptor.name, args: isRecord(params) ? params : {} };
      const result = await toolRegistry.invokeWithTimeout(
        call,
        {
          callId: toolCallId,
          taskId: state.task.id,
          taskGoal: state.task.goal,
          task: state.task,
          abortSignal: signal ?? state.abortController.signal,
          workspaceDir: state.taskWorkspace,
          externalPaths: state.externalPaths,
          publishEvent: (event) => taskEvents.publish(event as AgentEvent),
        },
        config.agent.toolTimeoutMs,
      );
      if (!result.ok) {
        throw new Error(result.error);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.output ?? null) }],
        details: result,
      };
    },
  }));
  const byName = new Set(tools.map((tool) => tool.name));
  const aliases: AgentTool[] = [];
  if (!byName.has('read_file') && byName.has('read')) {
    aliases.push(makeAliasTool(state, 'read_file', 'read', 'Read a UTF-8 text file in the workspace.', ['path']));
  }
  if (!byName.has('http_fetch') && byName.has('web_fetch')) {
    aliases.push(makeAliasTool(state, 'http_fetch', 'web_fetch', 'Fetch an approved HTTP/HTTPS URL.', ['url']));
  }
  if (!byName.has('search_files') && byName.has('search_grep')) {
    aliases.push(makeAliasTool(state, 'search_files', 'search_grep', 'Search workspace files for matching text.', ['query']));
  }
  return [...tools, ...aliases];
}

function makeAliasTool(
  state: PiRunState,
  alias: string,
  target: string,
  description: string,
  required: string[],
): AgentTool {
  return {
    name: alias,
    label: alias,
    description,
    parameters: Type.Unsafe({
      type: 'object',
      properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])),
      required,
      additionalProperties: true,
    }) as TSchema,
    executionMode: executionPolicyOfCall(target).parallelizable === false ? 'sequential' : 'parallel',
    execute: async (toolCallId, params, signal) => {
      const args = normalizeAliasArgs(alias, target, isRecord(params) ? params : {});
      if (alias === 'read_file') {
        if (typeof args.path !== 'string') {
          throw new Error('工具参数不符合 schema：args.path 必须是 string');
        }
        const path = args.path;
        const { resolveInWorkspace, assertRealPathInside } = await import('../tools/builtins.js');
        const absPath = resolveInWorkspace(path, state.taskWorkspace, state.externalPaths);
        await assertRealPathInside(absPath, state.taskWorkspace, state.externalPaths);
        const content = await fs.readFile(absPath, 'utf8');
        return {
          content: [{ type: 'text' as const, text: content }],
          details: { callId: toolCallId, ok: true, output: { content }, aliasFor: target },
        };
      }
      const result = await toolRegistry.invokeWithTimeout(
        { id: toolCallId, toolName: target, args },
        {
          callId: toolCallId,
          taskId: state.task.id,
          taskGoal: state.task.goal,
          task: state.task,
          abortSignal: signal ?? state.abortController.signal,
          workspaceDir: state.taskWorkspace,
          externalPaths: state.externalPaths,
          publishEvent: (event) => taskEvents.publish(event as AgentEvent),
        },
        config.agent.toolTimeoutMs,
      );
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.output ?? null) }],
        details: { ...result, aliasFor: target },
      };
    },
  };
}

function normalizeAliasArgs(alias: string, target: string, args: Record<string, unknown>): Record<string, unknown> {
  if (alias === 'read_file' && target === 'read') {
    return { path: args.path, offset: args.offset, limit: args.limit };
  }
  if (alias === 'search_files' && target === 'search_grep') {
    const normalized: Record<string, unknown> = {
      pattern: args.query ?? args.pattern,
      glob: args.glob,
    };
    const maxResults = args.maxResults ?? args.limit;
    if (maxResults !== undefined) normalized.maxResults = maxResults;
    return normalized;
  }
  return args;
}

async function handlePiEvent(state: PiRunState, event: PiAgentEvent): Promise<void> {
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    if (update.type === 'text_delta') {
      state.task.budgetUsage = state.task.budgetUsage ?? initialBudgetUsage();
      state.task.budgetUsage.outputBytes += Buffer.byteLength(update.delta);
      assertBudgetWithinLimits(state.task);
      taskEvents.publish({ type: 'token', taskId: state.task.id, delta: update.delta });
    }
    return;
  }

  if (event.type === 'message_end') {
    const converted = fromPiMessage(event.message, state);
    if (!converted) return;
    if (converted.role === 'user') return;
    if (!hasEquivalentMessage(state.task.messages, converted)) {
      state.task.messages.push(converted);
      taskEvents.publish({ type: 'message', taskId: state.task.id, message: converted });
      taskStore.save(state.task);
    }
    return;
  }

  if (event.type === 'tool_execution_start') {
    setTaskPhase(state, 'calling_tool', `执行：${event.toolName}`, 'running');
    return;
  }

  if (event.type === 'tool_execution_end') {
    if (state.pendingToolCallById.has(event.toolCallId)) return;
    const call: ToolCall = {
      id: event.toolCallId,
      toolName: event.toolName,
      args: {},
    };
    const risk = riskLevelOfCall(call.toolName);
    const result = piToolResultToAurevoy(call, event.result, !!event.isError);
    if (!result.ok && call.toolName === 'read_file' && result.error && !/schema/i.test(result.error)) {
      result.error = `schema validation failed: ${result.error}`;
    }
    taskEvents.publish({ type: 'tool_result', taskId: state.task.id, result });
    state.internals.writeTrace(state.task.id, 'tool_result', 'calling_tool', {
      iteration: state.currentIteration,
      callId: call.id,
      toolName: call.toolName,
      riskLevel: risk,
      ok: result.ok,
      errorCategory: result.ok ? undefined : 'tool',
      errorMessage: result.error,
      summary: result.ok ? `工具成功：${call.toolName}` : `工具失败：${call.toolName}`,
      data: result.ok ? { output: state.internals.summarizePayload(result.output) } : undefined,
    });
    return;
  }

  if (event.type === 'turn_end') return;
}

function aurevoyStreamFn(state: PiRunState, _model: Model<any>, llmContext: PiLlmContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const signal = options?.signal;
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const startedAt = Date.now();
    const partial = makePiAssistant('', 'stop', undefined, undefined);
    stream.push({ type: 'start', partial });
    let textBuffer = '';
    let reasoningBuffer = '';
    let toolCalls: AccumulatedToolCall[] = [];
    let finishReason: string | undefined;
    let usage: TokenUsage | null | undefined;
    try {
      await withRetry(async () => {
        textBuffer = '';
        reasoningBuffer = '';
        toolCalls = [];
        finishReason = undefined;
        usage = undefined;
        const messages = llmContext.messages.map(fromPiMessageLoose).filter((m): m is Message => m !== null);
        const providerStream = getProvider().stream(messages, {
          tools: toolRegistry.list(),
          toolChoice: 'auto',
          signal,
        });
        for await (const chunk of providerStream) {
          if (chunk.textDelta) {
            if (!textBuffer) stream.push({ type: 'text_start', contentIndex: 0, partial: makePiAssistant('', 'stop') });
            textBuffer += chunk.textDelta;
            stream.push({
              type: 'text_delta',
              contentIndex: 0,
              delta: chunk.textDelta,
              partial: makePiAssistant(textBuffer, 'stop', reasoningBuffer, toolCalls),
            });
          }
          if (chunk.reasoningContentDelta) {
            reasoningBuffer += chunk.reasoningContentDelta;
            stream.push({
              type: 'thinking_delta',
              contentIndex: textBuffer ? 1 : 0,
              delta: chunk.reasoningContentDelta,
              partial: makePiAssistant(textBuffer, 'stop', reasoningBuffer, toolCalls),
            });
          }
          if (chunk.done) {
            finishReason = chunk.finishReason;
            toolCalls = chunk.toolCallsSnapshot ?? [];
            usage = chunk.tokenUsage;
          }
        }
      }, signal ?? new AbortController().signal);
      if (textBuffer) {
        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: textBuffer,
          partial: makePiAssistant(textBuffer, 'stop', reasoningBuffer, toolCalls, usage),
        });
      }
      const message = makePiAssistant(
        textBuffer,
        finishReason === 'length' ? 'length' : toolCalls.length > 0 ? 'toolUse' : 'stop',
        reasoningBuffer,
        toolCalls,
        usage,
      );
      const tokenUsage = usage ?? null;
      const aggregatedUsage = addPiTokenUsage(state.task, fromProviderUsage(tokenUsage));
      taskEvents.publish({ type: 'token_usage', taskId: state.task.id, usage: aggregatedUsage });
      state.internals.writeTrace(state.task.id, 'llm', 'thinking', {
        iteration: state.currentIteration,
        startedAtMs: startedAt,
        tokenUsage,
        ok: true,
        finishReason: finishReason === 'tool_calls' ? 'tool_calls' : finishReason,
        summary: finishReason === 'tool_calls' ? '模型请求工具调用' : '模型返回回复',
        data: {
          outputChars: textBuffer.length,
          reasoningChars: reasoningBuffer.length,
          toolCallCount: toolCalls.length,
          runtime: 'pi',
        },
      });
      toolCalls.forEach((toolCall, index) => {
        const piCall = toPiToolCall(toolCall);
        stream.push({ type: 'toolcall_start', contentIndex: message.content.findIndex((c) => c.type === 'toolCall' && c.id === piCall.id), partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: piCall, partial: message });
      });
      stream.push({
        type: 'done',
        reason: message.stopReason as Extract<AssistantMessage['stopReason'], 'stop' | 'length' | 'toolUse'>,
        message,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      state.internals.writeTrace(state.task.id, 'llm', 'thinking', {
        iteration: state.currentIteration,
        startedAtMs: startedAt,
        ok: false,
        errorCategory: state.internals.classifyError(err),
        errorMessage,
        summary: 'Pi Agent 模型调用失败',
      });
      const message = makePiAssistant(textBuffer, 'error', reasoningBuffer, toolCalls, usage, errorMessage);
      message.diagnostics = [{ type: 'error', message: errorMessage, timestamp: startedAt } as NonNullable<AssistantMessage['diagnostics']>[number]];
      stream.push({ type: 'error', reason: signal?.aborted ? 'aborted' : 'error', error: message });
    }
  })();
  return stream;
}

function makeAurevoyPiModel(): Model<any> {
  return {
    id: config.llm.model,
    name: config.llm.model,
    api: `aurevoy-${config.llm.provider}`,
    provider: 'aurevoy',
    baseUrl: config.llm.baseUrl,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.agent.contextTokenBudget,
    maxTokens: 8192,
  };
}

function makePiAssistant(
  text: string,
  stopReason: AssistantMessage['stopReason'],
  reasoning?: string,
  toolCalls?: AccumulatedToolCall[],
  tokenUsage?: TokenUsage | null,
  errorMessage?: string,
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (text) content.push({ type: 'text', text });
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  for (const toolCall of toolCalls ?? []) content.push(toPiToolCall(toolCall));
  return {
    role: 'assistant',
    content,
    api: `aurevoy-${config.llm.provider}`,
    provider: 'aurevoy',
    model: config.llm.model,
    usage: toPiUsage(tokenUsage),
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function toPiUsage(usage?: TokenUsage | null): Usage {
  const input = usage?.promptTokens ?? 0;
  const output = usage?.completionTokens ?? 0;
  const total = usage?.totalTokens ?? input + output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function fromProviderUsage(usage: TokenUsage | null | undefined): AggregatedTokenUsage {
  return {
    available: !!usage,
    provider: config.llm.provider,
    model: config.llm.model,
    promptTokens: usage?.promptTokens,
    completionTokens: usage?.completionTokens,
    totalTokens: usage?.totalTokens,
    updatedAt: new Date().toISOString(),
  };
}

function addPiTokenUsage(task: Task, usage: AggregatedTokenUsage): AggregatedTokenUsage {
  const current = task.tokenUsage;
  if (!current?.available) {
    task.tokenUsage = usage;
    return usage;
  }
  const next: AggregatedTokenUsage = {
    available: true,
    provider: usage.provider,
    model: usage.model,
    promptTokens: (current.promptTokens ?? 0) + (usage.promptTokens ?? 0),
    completionTokens: (current.completionTokens ?? 0) + (usage.completionTokens ?? 0),
    totalTokens: (current.totalTokens ?? 0) + (usage.totalTokens ?? 0),
  };
  task.tokenUsage = next;
  return next;
}

function toPiToolCall(toolCall: AccumulatedToolCall): PiToolCall {
  return {
    type: 'toolCall',
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: parseJsonObject(toolCall.function.arguments),
  };
}

function toPiMessage(message: Message): AgentMessage | null {
  if (message.role === 'user') {
    return { role: 'user', content: message.content, timestamp: Date.parse(message.createdAt) };
  }
  if (message.role === 'assistant') {
    const toolCalls = (message.toolCalls ?? []).map((tc): PiToolCall => ({
      type: 'toolCall',
      id: tc.id,
      name: tc.function.name,
      arguments: parseJsonObject(tc.function.arguments),
    }));
    const content: AssistantMessage['content'] = [];
    if (message.content) content.push({ type: 'text', text: message.content });
    if (message.reasoningContent) content.push({ type: 'thinking', thinking: message.reasoningContent });
    content.push(...toolCalls);
    return {
      role: 'assistant',
      content,
      api: `aurevoy-${config.llm.provider}`,
      provider: 'aurevoy',
      model: config.llm.model,
      usage: toPiUsage(null),
      stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop',
      timestamp: Date.parse(message.createdAt),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId ?? randomUUID(),
      toolName: 'tool',
      content: [{ type: 'text', text: message.content }],
      isError: false,
      timestamp: Date.parse(message.createdAt),
    };
  }
  if (message.role === 'system') return null;
  return null;
}

function fromPiMessage(message: AgentMessage, state: PiRunState): Message | null {
  const converted = fromPiMessageLoose(message);
  if (!converted) return null;
  if (converted.role === 'assistant' && converted.toolCalls?.length) {
    converted.toolCalls = converted.toolCalls.map((tc) => ({
      ...tc,
      function: {
        ...tc.function,
        planStepId: state.planStepIdByCallId.get(tc.id),
      } as MessageToolCall['function'],
    }));
  }
  return converted;
}

function fromPiMessageLoose(message: AgentMessage): Message | null {
  if (!isRecord(message) || typeof message.role !== 'string') return null;
  const role = String(message.role);
  const now = new Date(typeof message.timestamp === 'number' ? message.timestamp : Date.now()).toISOString();
  if (role === AUREVOY_SYSTEM_MESSAGE_ROLE) {
    const content = (message as unknown as { content?: unknown }).content;
    return {
      id: randomUUID(),
      role: 'system',
      content: piContentToText(content),
      createdAt: now,
    };
  }
  if (role === 'user') {
    return {
      id: randomUUID(),
      role: 'user',
      content: piContentToText(message.content),
      createdAt: now,
    };
  }
  if (message.role === 'assistant') {
    const assistant = message as AssistantMessage;
    const text = assistant.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('');
    const reasoning = assistant.content.filter((c) => c.type === 'thinking').map((c) => c.thinking).join('');
    const toolCalls = assistant.content.filter((c): c is PiToolCall => c.type === 'toolCall').map((tc): MessageToolCall => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
    }));
    const result: Message = { id: randomUUID(), role: 'assistant', content: text, createdAt: now };
    if (reasoning) result.reasoningContent = reasoning;
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    return result;
  }
  if (message.role === 'toolResult') {
    return {
      id: randomUUID(),
      role: 'tool',
      content: piContentToText(message.content),
      toolCallId: message.toolCallId,
      createdAt: now,
    };
  }
  return null;
}

function hasEquivalentMessage(messages: Message[], candidate: Message): boolean {
  if (candidate.role === 'assistant' && candidate.toolCalls?.length) {
    const candidateCallIds = candidate.toolCalls.map((toolCall) => toolCall.id).sort().join(',');
    return messages.some((message) =>
      message.role === 'assistant' &&
      (message.toolCalls?.length ?? 0) > 0 &&
      message.toolCalls!.map((toolCall) => toolCall.id).sort().join(',') === candidateCallIds,
    );
  }
  return messages.some((message) =>
    message.role === candidate.role &&
    message.content === candidate.content &&
    message.toolCallId === candidate.toolCallId &&
    JSON.stringify(message.toolCalls ?? []) === JSON.stringify(candidate.toolCalls ?? []),
  );
}

function convertPiMessagesToLlm(messages: AgentMessage[]): PiMessage[] {
  return messages.filter((message): message is PiMessage =>
    isRecord(message) && ['user', 'assistant', 'toolResult', AUREVOY_SYSTEM_MESSAGE_ROLE].includes(String(message.role)),
  );
}

function piContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '').join('');
}

function piToolResultToAurevoy(call: ToolCall, result: AgentToolResult<unknown>, isError: boolean): ToolResult {
  const details = isRecord(result.details) && 'ok' in result.details ? result.details as unknown as ToolResult : null;
  if (details) return details;
  const text = piContentToText(result.content);
  if (isError) return { callId: call.id, ok: false, error: text || '工具执行失败' };
  return { callId: call.id, ok: true, output: parseMaybeJson(text) };
}

function riskLevelOfCall(toolName: string): ToolRiskLevel {
  return toolRegistry.riskLevelOf(TOOL_ALIASES.get(toolName) ?? toolName);
}

function executionPolicyOfCall(toolName: string) {
  return toolRegistry.executionPolicyOf(TOOL_ALIASES.get(toolName) ?? toolName);
}

async function resolveAskUserAsTool(state: PiRunState, call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
  const question = typeof call.args.question === 'string' && call.args.question.trim()
    ? call.args.question.trim()
    : '请补充完成任务所需的信息。';
  const options = Array.isArray(call.args.options)
    ? call.args.options.filter((item): item is string => typeof item === 'string')
    : undefined;
  const context = typeof call.args.context === 'string' ? call.args.context : undefined;
  const clarification = createClarification({ callId: call.id, question, options, context });
  state.task.clarifications = [...(state.task.clarifications ?? []), clarification];
  taskStore.patch(state.task.id, { phase: state.task.phase, status: state.task.status });
  taskEvents.publish({ type: 'clarification_request', taskId: state.task.id, clarification });
  state.internals.writeTrace(state.task.id, 'tool_call', 'waiting_clarification', {
    iteration: state.currentIteration,
    callId: call.id,
    toolName: 'ask_user',
    riskLevel: 'safe',
    ok: true,
    summary: 'Agent 发起追问',
    data: { question, options, context },
  });
  const answer = await state.internals.waitForClarification(state.task.id, clarification.id, signal);
  const resolved = answer == null
    ? resolveClarification(state.task, clarification.id, 'timeout')
    : resolveClarification(state.task, clarification.id, 'answered', answer);
  if (resolved) taskEvents.publish({ type: 'clarification_resolved', taskId: state.task.id, clarification: resolved });
  const result: ToolResult = answer == null
    ? { callId: call.id, ok: false, error: '用户未回复追问，等待已超时' }
    : { callId: call.id, ok: true, output: { answer } };
  taskEvents.publish({ type: 'tool_result', taskId: state.task.id, result });
  return result;
}

async function captureSnapshotForCall(state: PiRunState, call: ToolCall): Promise<void> {
  if (typeof call.args.path !== 'string') return;
  const absPath = new URL(call.args.path, `file://${state.taskWorkspace}/`).pathname;
  const snapshotId = await state.internals.captureFileSnapshot(absPath, state.task.id, state.taskWorkspace);
  if (!snapshotId) return;
  const snapshot: FileSnapshot = {
    id: snapshotId,
    path: call.args.path,
    callId: call.id,
    createdAt: new Date().toISOString(),
  };
  state.task.fileSnapshots = [...(state.task.fileSnapshots ?? []), snapshot];
}

function isAutoApproved(state: PiRunState, call: ToolCall): boolean {
  const sessionApprovedApprovalKeys = new Set(state.task.approvedApprovalKeys ?? []);
  if (riskLevelOfCall(call.toolName) === 'safe') return true;
  if (call.toolName === 'read_file') return true;
  if (state.internals.isApprovalFreeTool(call.toolName)) return true;
  if (sessionApprovedApprovalKeys.has(state.internals.approvalKeyForCall(call))) return true;
  if (sessionApprovedApprovalKeys.has(state.internals.prefixApprovalKeyForCall(call))) return true;
  if (state.currentAutoModePaused || state.currentAutoModeLevel === 'off') return false;
  if (state.currentAutoModeLevel === 'plan') return PLANMODE_TOOLS.has(call.toolName);
  if (state.currentAutoModeLevel === 'full') return true;
  if (state.currentAutoModeLevel === 'auto-edit') return AUTO_EDIT_TOOLS.has(call.toolName);
  return false;
}

function setTaskPhase(state: PiRunState, phase: TaskPhase, detail?: string, status?: TaskStatus): void {
  if (status && state.task.status !== status) {
    state.task.status = status;
    taskEvents.publish({ type: 'status', taskId: state.task.id, status });
  }
  state.task.phase = phase;
  taskStore.patch(state.task.id, {
    status: state.task.status,
    phase: state.task.phase,
    budgetUsage: state.task.budgetUsage,
    pendingApprovals: state.task.pendingApprovals,
    approvedApprovalKeys: state.task.approvedApprovalKeys,
  });
  state.internals.writeTrace(state.task.id, 'phase', phase, { ok: true, summary: detail });
  taskEvents.publish({ type: 'phase', taskId: state.task.id, phase, detail });
}

async function handlePlanModeFinalReply(
  task: Task,
  internals: RuntimeInternals,
  abortController: AbortController,
  assistantMsg: Message,
  setRuntimePhase: (phase: TaskPhase, detail?: string, status?: TaskStatus) => void,
  touch: () => void,
  saveFull: () => void,
  updateStep: (d: string, s: PlanStep['status']) => void,
): Promise<void> {
  task.autoModeState!.planReady = true;
  task.autoModeState!.planContent = assistantMsg.content || assistantMsg.reasoningContent || '(empty plan)';
  touch();
  setRuntimePhase('waiting_approval', 'Agent 已完成勘探，等待用户审批计划', 'paused');
  taskEvents.publish({
    type: 'plan_approval_request',
    taskId: task.id,
    plan: [{ id: 'plan', description: task.autoModeState!.planContent.slice(0, 500), status: 'proposed', source: 'llm' }],
    reasoning: 'Plan Mode 完成勘探，请审阅计划并批准以开始执行',
  });
  const decision = await internals.waitForPlanApproval(task.id, abortController.signal);
  if (abortController.signal.aborted) return internals.finishCancelled(task, updateStep, saveFull);
  taskEvents.publish({
    type: 'plan_approval_resolved',
    taskId: task.id,
    approved: decision.approved,
    reason: decision.reason,
  });
  if (!decision.approved) {
    task.autoModeState!.planReady = false;
    touch();
    setRuntimePhase('finalizing', decision.reason ? `用户拒绝计划：${decision.reason}` : '用户拒绝计划', 'completed');
    return internals.finishCompleted(task, updateStep, saveFull);
  }
  const targetMode = task.autoModeState!.planPreMode ?? 'auto-edit';
  task.autoModeState!.level = targetMode;
  task.autoModeState!.planPreMode = undefined;
  task.autoModeState!.planContent = undefined;
  touch();
  setRuntimePhase('finalizing', `计划已批准，请继续任务以 ${targetMode} 模式执行`, 'completed');
  return internals.finishCompleted(task, updateStep, saveFull);
}

function stateSafeActiveStepIndex(task: Task, current: number): number {
  const running = task.plan.findIndex((step) => step.status === 'running');
  if (running >= 0) return running;
  return Math.max(0, Math.min(current, task.plan.length - 1));
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseMaybeJson(value);
  return isRecord(parsed) ? parsed : {};
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
