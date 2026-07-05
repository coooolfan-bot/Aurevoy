import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, resolve } from 'node:path';
import Fastify from 'fastify';
import pino, { type Logger } from 'pino';
import cors from '@fastify/cors';
import './tools/builtins.js';
import './tools/file-basics.js';
import './tools/new-tools.js';
import type {
  AgentEvent,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  BranchTaskRequest,
  BranchTaskResponse,
  ClarificationAnswerRequest,
  ClarificationAnswerResponse,
  CleanupDataRequest,
  CleanupDataResponse,
  CompactTaskRequest,
  CompactTaskResponse,
  ContinueTaskRequest,
  ContinueTaskResponse,
  CreateMemoryRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  DataStatusResponse,
  DeleteTaskResponse,
  HealthResponse,
  MemoryCategory,
  MemoryEntry,
  MemoryListResponse,
  ModelListResponse,
  PlanApprovalRequest,
  PlanApprovalResponse,
  ProjectListResponse,
  ResumeTaskResponse,
  RevertTaskRequest,
  RevertTaskResponse,
  SkillDescriptor,
  SkillInstallRequest,
  SkillInstallResponse,
  SkillListResponse,
  SkillUninstallResponse,
  UnrevertTaskResponse,
  TaskArtifactContentResponse,
  TaskArtifactListResponse,
  TaskTraceListResponse,
  TokenUsageReport,
  UpdateProjectRequest,
  UpdateTaskArtifactRequest,
  UpdateRuntimeSettingsRequest,
  UpdateToolRequest,
  UpdateMemoryRequest,
} from '@aurevoy/shared';
import { config } from './config.js';
import {
  addUserTurn,
  branchTask,
  cancelTask,
  compactTask,
  createTask,
  isTaskRunning,
  markInterruptedTasksAfterRestart,
  prepareTaskForResume,
  resolveApproval,
  resolveClarificationAnswer,
  resolvePlanApproval,
  resumeAutoMode,
  revertTask,
  runTask,
  unrevertTask,
} from './agent/loop.js';
import { taskEvents } from './agent/events.js';
import { taskStore, traceStore, memoryStore, toolSettingsStore, skillSettingsStore, projectStore, invalidateMemorySummary } from './store/db.js';
import { toolRegistry } from './tools/registry.js';
import { skillRegistry } from './skills/registry.js';
import { installFromGit, uninstallSkill } from './skills/installer.js';
import { reloadSkillsAndTools } from './skills/reload.js';
import { getProviderName, listProviderModels } from './llm/provider.js';
import { getMcpStatuses, reloadMcpTools } from './tools/mcp.js';
import {
  readCleanupPolicyDays,
  readRuntimeSettings,
  updateRuntimeSettings,
} from './runtime/settings.js';

const startedAt = Date.now();

export async function buildServer(externalLogger?: Logger) {
  const log = externalLogger ?? pino({ level: 'info' }, pino.destination(1));
  const app = Fastify({ loggerInstance: log });

  app.addHook('onRequest', async (req) => {
    (req.raw as unknown as Record<string, unknown>).requestId = randomUUID();
  });

  toolRegistry.applySettings(toolSettingsStore.list());
  toolRegistry.setEnabled('execute_command', config.sandbox.commandExecutionEnabled);
  const recoveredTasks = markInterruptedTasksAfterRestart();
  if (recoveredTasks.length > 0) {
    log.warn(`启动恢复：${recoveredTasks.length} 个未完成任务已标记为可恢复失败`);
  }

  await app.register(cors, { origin: config.corsOrigins });

  // 健康检查
  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      version: '0.5.11',
      uptimeMs: Date.now() - startedAt,
      provider: getProviderName(),
      contextCharBudget: config.agent.contextCharBudget,
      contextTokenBudget: config.agent.contextTokenBudget,
    };
  });

  // 已注册工具列表（调试/前端展示用）
  app.get('/api/tools', async () => toolRegistry.listAll());

  app.get('/api/skills', async (): Promise<SkillListResponse> => {
    return { skills: skillRegistry.listAll() };
  });

  app.post('/api/skills/reload', async (): Promise<SkillListResponse> => {
    const skills = reloadSkillsAndTools();
    return { skills };
  });

  app.post<{ Body: SkillInstallRequest }>('/api/skills/install', async (req, reply) => {
    const repoUrl = typeof req.body?.repoUrl === 'string' ? req.body.repoUrl.trim() : '';
    if (!repoUrl) {
      return reply.code(400).send({ error: 'repoUrl 不能为空' });
    }

    try {
      const targetDir = resolve(config.skills.userDir);
      const result = await installFromGit(repoUrl, targetDir);
      reloadSkillsAndTools();

      const response: SkillInstallResponse = {
        installedSkills: result.installedSkills,
        repoUrl,
        alreadyExisted: result.alreadyExisted,
        totalFound: result.totalFound,
      };
      return reply.code(201).send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete<{ Params: { name: string } }>('/api/skills/:name', async (req, reply) => {
    const name = req.params.name;
    const entry = skillRegistry.get(name);
    if (!entry) {
      return reply.code(404).send({ error: 'skill 不存在' });
    }
    if (entry.sourceDir !== 'user' && entry.sourceDir !== 'system') {
      return reply.code(403).send({ error: '仅用户或系统级 skill 可以卸载' });
    }

    try {
      // 使用 skill 的 actual skillDir 所在父目录作为卸载目标
      const parentDir = resolve(entry.skillDir, '..');
      await uninstallSkill(name, parentDir);
      reloadSkillsAndTools();

      const response: SkillUninstallResponse = { name, deleted: true };
      return reply.send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.patch<{ Params: { name: string }; Body: { enabled: boolean } }>(
    '/api/skills/:name',
    async (req, reply) => {
      const name = req.params.name;
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled(boolean) 必填' });
      }
      const entry = skillRegistry.get(name);
      if (!entry) return reply.code(404).send({ error: 'skill not found' });
      skillSettingsStore.setEnabled(name, enabled);
      // 刷新 load_skill / install_skill 工具注册以同步 catalog
      reloadSkillsAndTools();
      const updated = skillRegistry.listAll().find((s) => s.name === name);
      return reply.send(updated as SkillDescriptor);
    },
  );

  app.patch<{ Params: { name: string }; Body: UpdateToolRequest }>(
    '/api/tools/:name',
    async (req, reply) => {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled(boolean) 必填' });
      }
      const updated = toolRegistry.setEnabled(req.params.name, enabled);
      if (!updated) return reply.code(404).send({ error: 'tool not found' });
      toolSettingsStore.setEnabled(req.params.name, enabled);
      const tool = toolRegistry.listAll().find((item) => item.name === req.params.name);
      return reply.send(tool);
    },
  );

  app.get('/api/mcp/status', async () => {
    return { servers: getMcpStatuses() };
  });

  app.get('/api/settings', async () => readRuntimeSettings());

  app.get('/api/settings/models', async (_req, reply): Promise<ModelListResponse | unknown> => {
    try {
      return { models: await listProviderModels() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.patch<{ Body: UpdateRuntimeSettingsRequest }>('/api/settings', async (req, reply) => {
    try {
      const result = updateRuntimeSettings(req.body ?? {});
      toolRegistry.setEnabled('execute_command', result.settings.commandExecutionEnabled);
      if (result.mcpChanged) {
        await reloadMcpTools();
        toolRegistry.applySettings(toolSettingsStore.list());
        toolRegistry.setEnabled('execute_command', result.settings.commandExecutionEnabled);
      }
      return reply.send(result.settings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  app.get('/api/data', async (): Promise<DataStatusResponse> => {
    return {
      dbPath: config.dbPath,
      workspaceDir: config.workspaceDir,
      cleanupPolicyDays: readCleanupPolicyDays(),
      counts: {
        tasks: taskStore.count(),
        traces: traceStore.count(),
        memories: memoryStore.count(),
        projects: projectStore.count(),
      },
    };
  });

  app.get('/api/data/token-usage', async (): Promise<TokenUsageReport> => {
    const tasks = taskStore.list();
    let available = false;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let estimatedCostUsd = 0;
    for (const task of tasks) {
      const usage = task.tokenUsage;
      if (!usage || !usage.available) continue;
      available = true;
      promptTokens += usage.promptTokens ?? 0;
      completionTokens += usage.completionTokens ?? 0;
      totalTokens += usage.totalTokens ?? 0;
      cacheReadTokens += usage.cacheReadTokens ?? 0;
      cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      estimatedCostUsd += usage.estimatedCostUsd ?? 0;
    }
    return {
      tasks: tasks.length,
      available,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estimatedCostUsd,
    };
  });

  app.post<{ Body: CleanupDataRequest }>('/api/data/cleanup', async (req): Promise<CleanupDataResponse> => {
    const olderThanDays = req.body?.olderThanDays ?? readCleanupPolicyDays();
    return taskStore.cleanupTerminal(olderThanDays);
  });

  // 任务列表（支持按项目过滤）
  app.get<{ Querystring: { projectId?: string } }>('/api/tasks', async (req) => {
    const projectId = req.query?.projectId;
    if (projectId === 'standalone') return taskStore.listByProject(null);
    if (projectId) return taskStore.listByProject(projectId);
    return taskStore.list();
  });

  // 单个任务详情
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
  });

  // 单个任务的持久轨迹
  app.get<{ Params: { id: string } }>('/api/tasks/:id/traces', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const body: TaskTraceListResponse = {
      taskId: req.params.id,
      traces: traceStore.list(req.params.id),
    };
    return reply.send(body);
  });

  // 创建并启动任务
  app.post<{ Body: CreateTaskRequest }>('/api/tasks', async (req, reply) => {
    const goal = req.body?.goal?.trim();
    if (!goal) return reply.code(400).send({ error: 'goal is required' });

    const projectId = req.body?.projectId;
    if (projectId) {
      const project = projectStore.get(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
    }

    const task = createTask(goal, req.body?.budget, projectId, req.body?.attachments);
    // 异步执行，立即返回；前端通过 SSE 订阅进度
    void runTask(task);

    taskEvents.publish({ type: 'task_created', taskId: task.id, task });

    const body: CreateTaskResponse = {
      task,
      streamUrl: `/api/tasks/${task.id}/stream`,
    };
    return reply.code(201).send(body);
  });

  // 多轮对话：在同一任务内追加一轮用户输入并继续执行（保留完整上下文）
  app.post<{ Params: { id: string }; Body: ContinueTaskRequest }>(
    '/api/tasks/:id/messages',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      if (isTaskRunning(req.params.id)) {
        return reply.code(409).send({ error: '任务正在运行，请等待当前轮结束后再追问' });
      }
      const message = req.body?.message?.trim();
      if (!message) return reply.code(400).send({ error: 'message is required' });

      addUserTurn(task, message, req.body?.attachments);
      // 异步带完整历史重跑循环；前端通过同一 SSE 地址订阅这一轮
      void runTask(task);

      const body: ContinueTaskResponse = {
        task,
        streamUrl: `/api/tasks/${task.id}/stream`,
      };
      return reply.code(202).send(body);
    },
  );

  // 任务恢复：从持久消息历史重新进入 Agent 循环，不伪造用户输入。
  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    if (isTaskRunning(req.params.id)) {
      return reply.code(409).send({ error: '任务正在运行，不能重复恢复' });
    }
    if (task.status === 'completed') {
      return reply.code(409).send({ error: '已完成任务不需要恢复' });
    }

    const resumed = prepareTaskForResume(task);
    void runTask(resumed);

    const body: ResumeTaskResponse = {
      task: resumed,
      streamUrl: `/api/tasks/${resumed.id}/stream`,
    };
    return reply.code(202).send(body);
  });

  // 恢复已暂停的 auto mode（重置连续计数，继续自动执行）
  app.post<{ Params: { id: string } }>('/api/tasks/:id/auto-mode-resume', (req, reply) => {
    const ok = resumeAutoMode(req.params.id);
    if (!ok) return reply.code(409).send({ error: 'auto mode 未处于暂停状态' });
    return reply.code(200).send({ ok: true });
  });

  // 编辑重跑（Phase 1）：截断到目标消息之前，回到该点状态；前端随后用 continue 端点
  // 把编辑后的文本作为该点的新输入，带上下文重新生成。
  app.post<{ Params: { id: string }; Body: RevertTaskRequest }>(
    '/api/tasks/:id/revert',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      if (isTaskRunning(req.params.id)) {
        return reply.code(409).send({ error: '任务正在运行，请等待当前轮结束后再编辑' });
      }
      const messageId = req.body?.messageId?.trim();
      if (!messageId) return reply.code(400).send({ error: 'messageId is required' });
      const mode = req.body?.mode ?? 'code_and_conv';

      const result = revertTask(task, messageId, mode);
      if (result.removedCount === 0) {
        return reply.code(404).send({ error: 'message not found in task history' });
      }
      const body: RevertTaskResponse = {
        task: result.task,
        removedContent: result.removedContent,
        removedMessageId: result.removedMessageId,
        removedCount: result.removedCount,
      };
      return reply.code(200).send(body);
    },
  );

  // 撤销上一次 revert：从归档恢复消息。仅在 revert 后尚未 continue 时可用。
  app.post<{ Params: { id: string } }>('/api/tasks/:id/unrevert', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    if (isTaskRunning(req.params.id)) {
      return reply.code(409).send({ error: '任务正在运行，不能撤销编辑' });
    }
    const result = unrevertTask(task);
    if (result.restoredCount === 0) {
      return reply.code(409).send({ error: '没有可撤销的编辑操作' });
    }
    const body: UnrevertTaskResponse = {
      task: result.task,
      restoredCount: result.restoredCount,
    };
    return reply.code(200).send(body);
  });

  // 分支：从指定消息处克隆出一个新任务（非破坏性 fork）
  app.post<{ Params: { id: string }; Body: BranchTaskRequest }>(
    '/api/tasks/:id/branch',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const messageId = req.body?.messageId?.trim();
      if (!messageId) return reply.code(400).send({ error: 'messageId is required' });

      const result = branchTask(task, messageId, req.body?.goal?.trim() || undefined);
      if (result.messageCount === 0) {
        return reply.code(404).send({ error: 'message not found in task history' });
      }
      taskEvents.publish({ type: 'task_created', taskId: result.task.id, task: result.task });
      const body: BranchTaskResponse = {
        task: result.task,
        streamUrl: `/api/tasks/${result.task.id}/stream`,
      };
      return reply.code(201).send(body);
    },
  );

  // 压缩：将指定消息范围压缩为 LLM 摘要，释放上下文空间
  app.post<{ Params: { id: string }; Body: CompactTaskRequest }>(
    '/api/tasks/:id/compact',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      if (isTaskRunning(req.params.id)) {
        return reply.code(409).send({ error: '任务正在运行，请等待当前轮结束后再压缩' });
      }

      const result = await compactTask(
        task,
        req.body?.fromMessageId?.trim() || undefined,
        req.body?.toMessageId?.trim() || undefined,
      );
      if (result.originalCount === 0) {
        return reply.code(400).send({ error: '指定的消息范围无效' });
      }
      const body: CompactTaskResponse = {
        task: result.task,
        originalCount: result.originalCount,
        summaryLength: result.summaryLength,
      };
      return reply.code(200).send(body);
    },
  );

  // 取消一个进行中的任务
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const cancelled = cancelTask(req.params.id);
    // 任务可能已结束（无活跃句柄）；此时返回当前状态即可
    return reply.send({ taskId: req.params.id, cancelling: cancelled, status: task.status });
  });

  // 删除任务及其关联数据
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });

    // 先取消进行中的任务，避免并发写入
    cancelTask(req.params.id);

    const result = taskStore.delete(req.params.id);

    // 通知 SSE 订阅者该任务已删除
    taskEvents.publish({ type: 'task_deleted', taskId: req.params.id });

    const body: DeleteTaskResponse = {
      taskId: req.params.id,
      deleted: result.deleted,
    };
    return reply.send(body);
  });

  // 对一次工具调用做出审批决策（批准/拒绝）
  app.post<{ Params: { id: string }; Body: ApprovalDecisionRequest }>(
    '/api/tasks/:id/approvals',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const { callId, approved, sessionApprove } = req.body ?? {};
      if (typeof callId !== 'string' || typeof approved !== 'boolean') {
        return reply.code(400).send({ error: 'callId(string) 与 approved(boolean) 必填' });
      }
      const delivered = resolveApproval(req.params.id, callId, approved, sessionApprove);
      const body: ApprovalDecisionResponse = { taskId: req.params.id, callId, delivered };
      return reply.send(body);
    },
  );

  // 审批 Plan Agent 生成的执行计划（批准/拒绝）
  app.post<{ Params: { id: string }; Body: PlanApprovalRequest }>(
    '/api/tasks/:id/plan-approval',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const { approved, reason } = req.body ?? {};
      if (typeof approved !== 'boolean') {
        return reply.code(400).send({ error: 'approved(boolean) 必填' });
      }
      const delivered = resolvePlanApproval(req.params.id, approved, reason);
      const body: PlanApprovalResponse = { taskId: req.params.id, delivered };
      return reply.send(body);
    },
  );

  // 回复 Agent 的结构化追问，同一任务从暂停点继续。
  app.post<{ Params: { id: string; clarificationId: string }; Body: ClarificationAnswerRequest }>(
    '/api/tasks/:id/clarifications/:clarificationId',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const answer = req.body?.answer?.trim();
      if (!answer) return reply.code(400).send({ error: 'answer is required' });
      const delivered = resolveClarificationAnswer(req.params.id, req.params.clarificationId, answer);
      const body: ClarificationAnswerResponse = {
        taskId: req.params.id,
        clarificationId: req.params.clarificationId,
        delivered,
      };
      return reply.send(body);
    },
  );

  app.get<{ Params: { id: string } }>('/api/tasks/:id/artifacts', async (req, reply) => {
    const task = taskStore.get(req.params.id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const body: TaskArtifactListResponse = {
      taskId: req.params.id,
      artifacts: task.artifacts ?? [],
    };
    return reply.send(body);
  });

  app.get<{ Params: { id: string; artifactId: string } }>(
    '/api/tasks/:id/artifacts/:artifactId/content',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const artifact = task.artifacts?.find((item) => item.id === req.params.artifactId);
      if (!artifact) return reply.code(404).send({ error: 'artifact not found' });
      const body: TaskArtifactContentResponse = {
        taskId: req.params.id,
        artifactId: req.params.artifactId,
        content: artifact.content,
        mimeType: artifact.mimeType,
      };
      return reply.send(body);
    },
  );

  app.patch<{ Params: { id: string; artifactId: string }; Body: UpdateTaskArtifactRequest }>(
    '/api/tasks/:id/artifacts/:artifactId',
    async (req, reply) => {
      const task = taskStore.get(req.params.id);
      if (!task) return reply.code(404).send({ error: 'task not found' });
      const status = req.body?.status;
      if (status !== 'confirmed' && status !== 'rejected') {
        return reply.code(400).send({ error: 'status 只能是 confirmed 或 rejected' });
      }
      const artifacts = task.artifacts ?? [];
      const index = artifacts.findIndex((item) => item.id === req.params.artifactId);
      if (index < 0) return reply.code(404).send({ error: 'artifact not found' });
      const artifact = { ...artifacts[index], status };
      artifacts[index] = artifact;
      task.artifacts = artifacts;
      task.updatedAt = new Date().toISOString();
      taskStore.save(task);
      taskEvents.publish({ type: 'artifact_updated', taskId: task.id, artifact });
      return reply.send(artifact);
    },
  );

  // ===== 长期记忆 CRUD (M4.3) =====
  const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
    'preference',
    'directory',
    'model',
    'habit',
    'fact',
    'other',
  ];
  const isCategory = (v: unknown): v is MemoryCategory =>
    typeof v === 'string' && MEMORY_CATEGORIES.includes(v as MemoryCategory);
  const clampConfidence = (v: unknown): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
    return Math.min(1, Math.max(0, n));
  };

  // 列出全部记忆（含禁用，供管理界面查看）
  app.get('/api/memories', async (): Promise<MemoryListResponse> => {
    return { memories: memoryStore.list() };
  });

  // 用户手动新增一条记忆
  app.post<{ Body: CreateMemoryRequest }>('/api/memories', async (req, reply) => {
    const content = req.body?.content?.trim();
    if (!content) return reply.code(400).send({ error: 'content is required' });
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      category: isCategory(req.body?.category) ? req.body.category : 'other',
      content,
      confidence: req.body?.confidence === undefined ? 1 : clampConfidence(req.body.confidence),
      enabled: true,
      source: { origin: 'user', createdAt: now },
      createdAt: now,
      updatedAt: now,
      embeddingUpdatedAt: null,
    };
    memoryStore.create(entry);
    invalidateMemorySummary();
    return reply.code(201).send(entry);
  });

  // 编辑 / 启停一条记忆
  app.patch<{ Params: { id: string }; Body: UpdateMemoryRequest }>(
    '/api/memories/:id',
    async (req, reply) => {
      const existing = memoryStore.get(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'memory not found' });
      const body = req.body ?? {};
      const patch: Partial<Pick<MemoryEntry, 'content' | 'category' | 'confidence' | 'enabled'>> = {};
      if (typeof body.content === 'string') {
        const trimmed = body.content.trim();
        if (!trimmed) return reply.code(400).send({ error: 'content 不能为空' });
        patch.content = trimmed;
      }
      if (body.category !== undefined) {
        if (!isCategory(body.category)) return reply.code(400).send({ error: 'category 非法' });
        patch.category = body.category;
      }
      if (body.confidence !== undefined) patch.confidence = clampConfidence(body.confidence);
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      const updated = memoryStore.update(req.params.id, patch);
      invalidateMemorySummary();
      return reply.send(updated);
    },
  );

  // 删除一条记忆
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
    const deleted = memoryStore.delete(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'memory not found' });
    invalidateMemorySummary();
    return reply.send({ id: req.params.id, deleted: true });
  });

  // ===== M8: 知识库 API =====
  const { listKbDirs, addKbDir, deleteKbDir, getKbIndexStatus } = await import("./knowledge-base/index.js");

  app.get("/api/knowledge-base/dirs", async () => {
    return { dirs: listKbDirs() };
  });

  app.post<{ Body: { dirPath: string; recursive?: boolean } }>("/api/knowledge-base/dirs", async (req, reply) => {
    const { dirPath, recursive } = req.body ?? {};
    if (!dirPath?.trim()) return reply.code(400).send({ error: "dirPath 不能为空" });
    try {
      return reply.code(201).send(addKbDir(dirPath.trim(), recursive !== false));
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : "添加目录失败" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/knowledge-base/dirs/:id", async (req, reply) => {
    const deleted = deleteKbDir(req.params.id);
    if (!deleted) return reply.code(404).send({ error: "kb dir not found" });
    return reply.send({ id: req.params.id, deleted: true });
  });

  app.get("/api/knowledge-base/status", async () => {
    return getKbIndexStatus();
  });



  // SSE 事件流：订阅某个任务的实时输出
  app.get<{ Params: { id: string } }>('/api/tasks/:id/stream', (req, reply) => {
    const { id } = req.params;
    const task = taskStore.get(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const origin = req.headers.origin;
    const corsOrigin = config.corsOrigins.includes('*')
      ? '*'
      : origin && config.corsOrigins.includes(origin)
        ? origin
        : config.corsOrigins[0];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': corsOrigin ?? '*',
      'X-Accel-Buffering': 'no',
    });

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = (): void => {};

    // ---- SSE 批量写入（cork + coalescing） ----
    let sseBuf: string[] = [];
    let sseTimer: ReturnType<typeof setImmediate> | null = null;

    const sseFlush = () => {
      sseTimer = null;
      if (sseBuf.length === 0) return;
      const batch = sseBuf;
      sseBuf = [];
      reply.raw.cork();
      for (const line of batch) reply.raw.write(line);
      reply.raw.uncork();
    };

    /** 需要立即刷入的事件类型 */
    const DRAIN_EVENTS = new Set([
      'done', 'task_deleted', 'error', 'status',
      'plan_approval_request', 'plan_approval_resolved',
      'clarification_request', 'clarification_resolved',
      'approval_request',
      'tool_call', 'tool_result', 'message',
    ]);

    const send = (event: AgentEvent) => {
      const line = `data: ${JSON.stringify(event)}\n\n`;

      if (event.type === 'done' || event.type === 'task_deleted') {
        if (sseBuf.length > 0) sseFlush();
        reply.raw.write(line);
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        taskEvents.cleanup(id);
        reply.raw.end();
        return;
      }

      sseBuf.push(line);

      if (DRAIN_EVENTS.has(event.type)) {
        if (sseTimer) clearImmediate(sseTimer);
        sseFlush();
      } else if (!sseTimer) {
        sseTimer = setImmediate(sseFlush);
      }
    };

    // 先补发数据库快照，保证 UI 可恢复。
    // 注意：快照必须在订阅实时事件之前完整发送，避免快照事件与实时事件在 SSE 缓冲区中交叠。
    send({ type: 'task_created', taskId: task.id, task });
    send({ type: 'status', taskId: task.id, status: task.status });
    if (task.phase) {
      send({ type: 'phase', taskId: task.id, phase: task.phase, detail: '数据库快照' });
    }
    if (task.plan.length > 0) {
      send({ type: 'plan', taskId: task.id, plan: task.plan });
    }
    if (task.budgetUsage) {
      send({ type: 'budget_usage', taskId: task.id, usage: task.budgetUsage, budget: task.budget });
    }
    if (task.tokenUsage) {
      send({ type: 'token_usage', taskId: task.id, usage: task.tokenUsage });
    }
    for (const message of task.messages) {
      send({ type: 'message', taskId: task.id, message });
    }
    for (const artifact of task.artifacts ?? []) {
      send({ type: 'artifact_updated', taskId: task.id, artifact });
    }
    for (const checkpoint of task.checkpoints ?? []) {
      send({ type: 'checkpoint_created', taskId: task.id, checkpoint });
    }
    for (const clarification of task.clarifications ?? []) {
      send(
        clarification.status === 'pending'
          ? { type: 'clarification_request', taskId: task.id, clarification }
          : { type: 'clarification_resolved', taskId: task.id, clarification },
      );
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      send({ type: 'done', taskId: task.id, status: task.status });
      return;
    }

    // 快照发送完毕，排空缓冲区后再订阅实时事件，避免快照与实时事件交叠
    if (sseBuf.length > 0) sseFlush();
    unsubscribe = taskEvents.subscribe(id, send);

    // 心跳，避免连接被中间层断开
    heartbeat = setInterval(() => {
      reply.raw.cork();
      reply.raw.write(': ping\n\n');
      reply.raw.uncork();
    }, 15000);

    req.raw.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      if (sseTimer) clearImmediate(sseTimer);
      sseBuf = [];
      unsubscribe();
    });
  });

  // ---- 项目 CRUD ----

  // 列出所有项目
  app.get('/api/projects', async (): Promise<ProjectListResponse> => {
    return { projects: projectStore.list() };
  });

  // 导入文件夹创建项目
  app.post<{ Body: CreateProjectRequest }>('/api/projects', async (req, reply) => {
    const rawPath = req.body?.path?.trim();
    if (!rawPath) return reply.code(400).send({ error: 'path is required' });

    const absPath = resolve(rawPath);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return reply.code(400).send({ error: 'path must be an existing directory' });
    }

    const existing = projectStore.getByPath(absPath);
    if (existing) return reply.code(409).send({ error: 'project with this path already exists' });

    const now = new Date().toISOString();
    const name = req.body?.name?.trim() || basename(absPath);
    const project = projectStore.create({
      id: randomUUID(),
      name,
      path: absPath,
      createdAt: now,
      updatedAt: now,
    });
    return reply.code(201).send(project);
  });

  // 重命名项目
  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>(
    '/api/projects/:id',
    async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: 'name is required' });
      const updated = projectStore.update(req.params.id, { name });
      if (!updated) return reply.code(404).send({ error: 'project not found' });
      return reply.send(updated);
    },
  );

  // 删除项目（关联对话变为独立对话）
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const result = projectStore.delete(req.params.id);
    if (!result.deleted) return reply.code(404).send({ error: 'project not found' });
    return reply.send(result);
  });

  return app;
}
