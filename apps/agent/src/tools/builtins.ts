import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { MemoryCategory, MemoryEntry } from '@aurevoy/shared';
import { config } from '../config.js';
import { toolRegistry } from './registry.js';
import { memoryStore } from '../store/db.js';
import { upsertMemoryVec } from '../store/db.js';
import { invalidateMemorySummary } from '../store/db.js';
import { getEmbeddingProvider } from '../embedding/provider.js';
import { commandExecutor } from '../sandbox/command-executor.js';
import { runSubTask } from '../agent/subagent.js';

/**
 * 内置基础工具：文件读写、目录列举、记忆、交互和命令执行。
 *
 * 安全约束：
 * - 路径校验在 Node.js 层完成（resolveInWorkspace + assertRealPathInside）。
 * - 实际读写/搜索操作使用系统命令（dd / grep / find / sed），
 *   通过 execFile（非 shell）传参，避免 shell 注入。
 * - 跨平台：macOS 优先，BSD 系命令。
 */

// ---- 路径安全校验（Node.js 层，命令执行前）----

/** 检查目标路径是否在受信任的外部路径范围内（用户拖拽/选择的文件/目录）。 */
export function isInsideExternalPath(target: string, externalPaths?: string[]): boolean {
  if (!externalPaths || externalPaths.length === 0) return false;
  const resolved = resolve(target);
  for (const ext of externalPaths) {
    const extResolved = resolve(ext);
    if (resolved === extResolved) return true;
    if (resolved.startsWith(`${extResolved}/`)) return true;
  }
  return false;
}

/** Agent 数据目录（skills/config/logs 等）始终可访问，不受工作区沙盒限制。 */
function getTrustedDirs(): string[] {
  const home = homedir();
  const dirs = [
    resolve(home, '.aurevoy'),
    resolve(home, '.agents'),
    resolve(home, '.claude'),
    resolve(home, '.codex'),
  ];
  // 内置 skill 目录（随 Agent 分发，可能不在工作区内）
  try {
    dirs.push(resolve(config.skills.builtinDir));
  } catch { /* 忽略 */ }
  // 工作区级 skill 子目录
  try {
    for (const sub of [
      config.skills.workspaceSubDir,
      config.skills.agentsWorkspaceSubDir,
      config.skills.claudeWorkspaceSubDir,
      config.skills.codexWorkspaceSubDir,
    ]) {
      dirs.push(resolve(config.workspaceDir, sub));
    }
  } catch { /* 忽略 */ }
  return dirs;
}

function isInsideTrustedDir(target: string): boolean {
  const resolved = resolve(target);
  for (const dir of getTrustedDirs()) {
    if (resolved === dir || resolved.startsWith(`${dir}/`)) return true;
  }
  return false;
}

export function resolveInWorkspace(
  input: unknown,
  workspaceRoot: string,
  externalPaths?: string[],
): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('path 必须是非空字符串');
  }
  const target = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input);

  // 受信任外部路径（用户拖拽文件/目录）放行
  if (isInsideExternalPath(target, externalPaths)) return target;

  // Agent 数据目录（~/.aurevoy, ~/.agents）始终放行
  if (isInsideTrustedDir(target)) return target;

  const rel = relative(workspaceRoot, target);
  if (rel === '') return target;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：只允许访问工作区目录内 (${workspaceRoot})`);
  }
  return target;
}

export async function ensureWorkspace(workspaceRoot: string): Promise<void> {
  await fs.mkdir(workspaceRoot, { recursive: true });
}

async function realpathOrNearest(p: string): Promise<string> {
  let probe = resolve(p);
  for (;;) {
    try {
      return await fs.realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      const parent = join(probe, '..');
      if (parent === probe) throw new Error(`无法解析路径: ${p}`);
      probe = parent;
    }
  }
}

export async function assertRealPathInside(
  target: string,
  workspaceRoot: string,
  externalPaths?: string[],
): Promise<void> {
  // 受信任外部路径放行
  if (isInsideExternalPath(target, externalPaths)) return;

  // Agent 数据目录放行
  if (isInsideTrustedDir(target)) return;

  await ensureWorkspace(workspaceRoot);
  const realRoot = await fs.realpath(workspaceRoot);
  const real = await realpathOrNearest(target);
  const rel = relative(realRoot, real);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`路径越界（符号链接指向工作区外）：只允许访问 ${workspaceRoot} 内`);
  }
}

export function workspaceRootPath(): string {
  return resolve(config.workspaceDir);
}

function rootAndExternals(context?: {
  workspaceDir?: string;
  externalPaths?: string[];
}): { root: string; externalPaths: string[] | undefined } {
  return {
    root: context?.workspaceDir ?? workspaceRootPath(),
    externalPaths: context?.externalPaths,
  };
}

// ---- 系统命令执行（execFile，非 shell）----

/**
 * 执行系统命令，返回 stdout。
 * grep 退出码 1（无匹配）视为正常空结果，不抛错。
 */

// ---- 工具函数 ----


function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
}


// ---- list_directory（safe）：ls -1p ----
toolRegistry.register({
  descriptor: {
    name: 'list_directory',
    description: '列出工作区内某个目录的条目（文件/子目录）。path 相对工作区根，缺省为根。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的目录路径，缺省为根目录' } },
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    await ensureWorkspace(root);
    const dir = resolveInWorkspace((args.path as string | undefined) ?? '.', root, extPaths);
    await assertRealPathInside(dir, root, extPaths);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      dir: relative(root, dir) || '.',
      entries: entries
        .filter((e) => e.name !== '.aurevoy-trash')
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
    };
  },
});

// read_file 已移除，由 file-basics 原语替代：open_file + scroll
// search_files 已移除，由 file-basics 原语替代：search_grep

// ---- copy_file（caution）----
toolRegistry.register({
  descriptor: {
    name: 'copy_file',
    description: '在工作区内复制文件。目标存在时默认拒绝覆盖，除非 overwrite=true。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '相对工作区的源文件路径' },
        targetPath: { type: 'string', description: '相对工作区的目标文件路径' },
        overwrite: { type: 'boolean', description: '是否覆盖已有目标文件，默认 false' },
      },
      required: ['sourcePath', 'targetPath'],
      additionalProperties: false,
    },
    riskLevel: 'caution',
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const source = resolveInWorkspace(args.sourcePath, root, extPaths);
    const target = resolveInWorkspace(args.targetPath, root, extPaths);
    await assertRealPathInside(source, root, extPaths);
    await fs.mkdir(join(target, '..'), { recursive: true });
    await assertRealPathInside(target, root, extPaths);
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
    if (args.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
    await fs.copyFile(source, target);
    return { sourcePath: relative(root, source), targetPath: relative(root, target), bytesCopied: sourceStat.size };
  },
});

// ---- move_file / rename_file（caution）----
const moveFileTool = {
  descriptor: {
    name: 'move_file',
    description: '在工作区内移动或重命名文件。目标存在时默认拒绝覆盖，除非 overwrite=true。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '相对工作区的源文件路径' },
        targetPath: { type: 'string', description: '相对工作区的目标文件路径' },
        overwrite: { type: 'boolean', description: '是否覆盖已有目标文件，默认 false' },
      },
      required: ['sourcePath', 'targetPath'],
      additionalProperties: false,
    },
    riskLevel: 'caution' as const,
  },
  async execute(args: Record<string, unknown>, context?: { workspaceDir?: string }) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const source = resolveInWorkspace(args.sourcePath, root, extPaths);
    const target = resolveInWorkspace(args.targetPath, root, extPaths);
    await assertRealPathInside(source, root, extPaths);
    await fs.mkdir(join(target, '..'), { recursive: true });
    await assertRealPathInside(target, root, extPaths);
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isFile()) throw new Error('sourcePath 不是文件');
    if (args.overwrite !== true && await pathExists(target)) throw new Error('targetPath 已存在；如需覆盖请显式传 overwrite=true');
    await fs.rename(source, target);
    return { sourcePath: relative(root, source), targetPath: relative(root, target), bytesMoved: sourceStat.size };
  },
};
toolRegistry.register(moveFileTool);
toolRegistry.register({
  ...moveFileTool,
  descriptor: { ...moveFileTool.descriptor, name: 'rename_file', description: 'move_file 的别名：在工作区内重命名文件。' },
});

// edit_file 已移除，统一走 search_grep → replace_lines 路径

// ---- delete_file（dangerous，默认禁用）----
toolRegistry.register({
  descriptor: {
    name: 'delete_file',
    description: '把工作区内文件移入工作区 .aurevoy-trash 回收区，不做永久删除。默认禁用，启用后仍需审批。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的待删除文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const file = resolveInWorkspace(args.path, root, extPaths);
    await assertRealPathInside(file, root, extPaths);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('path 不是文件');
    const trashDir = resolveInWorkspace('.aurevoy-trash', root, extPaths);
    await fs.mkdir(trashDir, { recursive: true });
    await assertRealPathInside(trashDir, root, extPaths);
    const trashName = `${Date.now()}-${relative(root, file).replace(/[/\\:]/g, '_')}`;
    const trashPath = join(trashDir, trashName);
    await fs.rename(file, trashPath);
    return { path: relative(root, file), trashedPath: relative(root, trashPath), bytesMoved: stat.size };
  },
});
toolRegistry.setEnabled('delete_file', false);


// ---- remember（safe）----
const MEMORY_CATEGORIES: readonly MemoryCategory[] = ['preference', 'directory', 'model', 'habit', 'fact', 'other'];
const MAX_MEMORY_CONTENT = 2000;

/**
 * M8: 异步为记忆生成并存储向量索引。
 * 嵌入成功时同时更新 embedding_updated_at 时间戳。
 * 嵌入失败时静默降级，不阻塞工具调用。
 */
async function generateMemoryEmbedding(memoryId: string, content: string): Promise<void> {
  try {
    const provider = getEmbeddingProvider();
    if (!provider) return;
    const vec = await provider.embed(content.slice(0, 2000));
    if (!upsertMemoryVec(memoryId, vec)) return;
    // 更新向量化时间戳
    memoryStore.update(memoryId, { embeddingUpdatedAt: new Date().toISOString() });
    // 记忆变更 → 清除摘要缓存
    invalidateMemorySummary();
  } catch {
    // 静默降级 — 不影响主流程
  }
}

/** P5: Jaccard 相似度（基于关键词集合）。 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

/** P5: 在已有记忆中查找相似内容（去重）。相似度 > 0.7 视为重复。 */
function findDuplicateMemory(
  newContent: string,
  existingMemories: MemoryEntry[],
): MemoryEntry | null {
  const newKeywords = new Set(
    newContent.toLowerCase().split(/[^a-z0-9一-鿿]+/i).filter((t) => t.length >= 2),
  );
  if (newKeywords.size === 0) return null;

  for (const existing of existingMemories) {
    const existingKeywords = new Set(
      existing.content.toLowerCase().split(/[^a-z0-9一-鿿]+/i).filter((t) => t.length >= 2),
    );
    const similarity = jaccardSimilarity(newKeywords, existingKeywords);
    if (similarity > 0.7) return existing;
  }
  return null;
}

toolRegistry.register({
  descriptor: {
    name: 'remember',
    description:
      '把一条关于用户的长期事实记下来，跨会话保留（如偏好、常用目录、工作习惯）。' +
      '使用 [[name-slug]] 语法引用其他记忆。' +
      '仅在信息明确且对将来有用时使用；不要记录临时上下文或敏感隐私。' +
      '用户可随时在记忆面板查看、编辑、停用或删除你记下的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要长期记住的内容（一句自然语言）。可使用 [[name-slug]] 引用其他记忆。' },
        category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: '分类：preference/directory/model/habit/fact/other' },
        confidence: { type: 'number', description: '你对这条记忆的置信度 0~1（默认 0.7）' },
        nameSlug: { type: 'string', description: 'URL slug，用于被其他记忆通过 [[slug]] 引用' },
        why: { type: 'string', description: '为什么记录这条记忆' },
        howToApply: { type: 'string', description: '什么情况下应该使用这条记忆' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args, context) {
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) throw new Error('content 必须是非空字符串');
    if (content.length > MAX_MEMORY_CONTENT) throw new Error(`记忆内容过长（上限 ${MAX_MEMORY_CONTENT} 字符）`);
    const category: MemoryCategory =
      typeof args.category === 'string' && MEMORY_CATEGORIES.includes(args.category as MemoryCategory)
        ? (args.category as MemoryCategory) : 'other';
    let confidence = typeof args.confidence === 'number' ? args.confidence : 0.7;
    if (!Number.isFinite(confidence)) confidence = 0.7;
    confidence = Math.min(1, Math.max(0, confidence));
    const nameSlug = typeof args.nameSlug === 'string' && args.nameSlug.trim()
      ? args.nameSlug.trim().toLowerCase().replace(/\s+/g, '-')
      : undefined;
    const why = typeof args.why === 'string' ? args.why.trim() : undefined;
    const howToApply = typeof args.howToApply === 'string' ? args.howToApply.trim() : undefined;
    const now = new Date().toISOString();

    // P5: 去重检查
    const duplicate = findDuplicateMemory(content, memoryStore.list());
    if (duplicate) {
      const updated = memoryStore.update(duplicate.id, {
        content,
        confidence: Math.max(duplicate.confidence, confidence),
        nameSlug: nameSlug ?? duplicate.nameSlug,
        why: why ?? duplicate.why,
        howToApply: howToApply ?? duplicate.howToApply,
      });
      // M8: 后台异步更新向量索引
      void generateMemoryEmbedding(duplicate.id, content);
      return {
        stored: true,
        id: duplicate.id,
        updated: true,
        category: updated?.category ?? duplicate.category,
        confidence: updated?.confidence ?? duplicate.confidence,
        note: '已更新已有记忆（内容相似度 > 70%）',
      };
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      category,
      content,
      confidence,
      enabled: true,
      source: { origin: 'agent', taskId: context?.taskId, taskGoal: context?.taskGoal, createdAt: now },
      nameSlug,
      why,
      howToApply,
      createdAt: now,
      updatedAt: now,
      embeddingUpdatedAt: null,
    };
    memoryStore.create(entry);
    // M8: 后台异步生成向量索引
    void generateMemoryEmbedding(entry.id, content);
    return { stored: true, id: entry.id, category, confidence, note: '已记入长期记忆，用户可在记忆面板管理。' };
  },
});

// ---- create_artifact（dangerous）：直接写入工作区文件，同时记录产物 ----
toolRegistry.register({
  descriptor: {
    name: 'create_artifact',
    description: '创建文件并写入工作区，同时生成产物记录（可在产物面板预览）。一次性完成创建+写入，无需额外确认或二次调用 apply_artifact。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '产物名称，例如 SUMMARY.md' },
        content: { type: 'string', description: '文件正文内容' },
        path: { type: 'string', description: '相对工作区的写入路径，例如 output/report.md' },
        type: { type: 'string', enum: ['text', 'file', 'diff', 'url'], description: '产物类型，默认 file' },
        mimeType: { type: 'string', description: 'MIME 类型，例如 text/markdown' },
      },
      required: ['name', 'content', 'path'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const name = readNonEmptyString(args.name, 'name');
    const content = typeof args.content === 'string' ? args.content : '';
    const path = readNonEmptyString(args.path, 'path');
    const type =
      args.type === 'file' || args.type === 'diff' || args.type === 'url'
        ? args.type as 'file' | 'diff' | 'url'
        : 'file' as const;
    const mimeType = typeof args.mimeType === 'string' ? args.mimeType : undefined;

    const file = resolveInWorkspace(path, root, extPaths);
    if (type === 'url') throw new Error('URL 类型产物不需要写入文件，请直接告知用户链接');
    await fs.mkdir(join(file, '..'), { recursive: true });
    await assertRealPathInside(file, root, extPaths);
    await fs.writeFile(file, content, 'utf8');

    const artifact = {
      id: randomUUID(),
      type,
      name,
      content: type === 'diff' ? content.slice(0, 100000) : content,
      mimeType,
      sourceCallId: context?.callId,
      status: 'applied' as const,
      appliedAt: new Date().toISOString(),
      appliedPath: relative(root, file),
      createdAt: new Date().toISOString(),
    };

    if (context?.task) {
      context.task.artifacts = [...(context.task.artifacts ?? []), artifact];
      context.publishEvent?.({ type: 'artifact_created', taskId: context.taskId, artifact });
    }

    return {
      artifactId: artifact.id,
      name,
      path: relative(root, file),
      bytesWritten: Buffer.byteLength(content),
    };
  },
});

// ---- ask_user（safe）：由 loop 接管 ----
toolRegistry.register({
  descriptor: {
    name: 'ask_user',
    description: '当目标信息不足、路径不存在、格式或选择不明确时，向用户提出一个结构化追问并等待回复。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的具体问题' },
        options: { type: 'array', items: { type: 'string' }, description: '可选答案列表；没有明确选项时可省略' },
        context: { type: 'string', description: '为什么需要追问的简短上下文' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute() {
    throw new Error('ask_user 由 Agent 循环接管，不能直接执行');
  },
});

// ---- apply_artifact（dangerous）：将已有 artifact 写入工作区文件 ----
toolRegistry.register({
  descriptor: {
    name: 'apply_artifact',
    description: '将已有 artifact 写入工作区内的目标文件（覆盖）。通常 create_artifact 已直接写入文件；仅在需要将已有产物写入不同路径时使用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: '要应用的 artifact id' },
        path: { type: 'string', description: '相对工作区的写入路径' },
      },
      required: ['artifactId', 'path'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args, context) {
    const { root, externalPaths: extPaths } = rootAndExternals(context);
    const artifactId = readNonEmptyString(args.artifactId, 'artifactId');
    const path = readNonEmptyString(args.path, 'path');
    const task = context?.task;
    const artifact = task?.artifacts?.find((item) => item.id === artifactId);
    if (!artifact) throw new Error(`artifact 不存在: ${artifactId}`);
    if (artifact.status === 'rejected') throw new Error('artifact 已被拒绝，不能写入文件');
    const file = resolveInWorkspace(path, root, extPaths);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await assertRealPathInside(file, root, extPaths);
    await fs.writeFile(file, artifact.content, 'utf8');
    return { artifactId, path: relative(root, file), bytesWritten: Buffer.byteLength(artifact.content) };
  },
});

// ---- attach_content（safe：Agent 在对话框中附加文件引用/图片/超链接）----
toolRegistry.register({
  descriptor: {
    name: 'attach_content',
    description: '在对话中附加文件引用、图片或超链接，使用户可以直观地访问文件或查看内容。通过此工具向用户展示文件位置、显示图片或提供重要链接。附加的内容会内联显示在对话消息中。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['file_reference', 'image', 'link'],
          description: '内容类型：file_reference 文件路径引用 / image 内联显示图片 / link 超链接',
        },
        content: { type: 'string', description: '文件路径、图片路径或 URL' },
        name: { type: 'string', description: '显示名称（可选，缺省用文件名或 URL）' },
        mimeType: { type: 'string', description: 'MIME 类型（可选，自动推断时可不传）' },
        size: { type: 'number', description: '文件大小（可选，仅文件引用类型建议传）' },
      },
      required: ['type', 'content'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args) {
    const type = args.type as string;
    if (!['file_reference', 'image', 'link'].includes(type)) {
      return { ok: false, error: `不支持的内容类型: ${type}` };
    }
    return {
      contentBlock: {
        type,
        content: String(args.content),
        name: typeof args.name === 'string' ? args.name : undefined,
        mimeType: typeof args.mimeType === 'string' ? args.mimeType : undefined,
        size: typeof args.size === 'number' ? args.size : undefined,
      },
    };
  },
});

// ---- execute_command（dangerous，默认禁用）----
toolRegistry.register({
  descriptor: {
    name: 'execute_command',
    description: '在工作区内执行一个基础命令。使用 shell=false，不支持管道/重定向；默认禁用，需设置页显式开启。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '可执行文件名或绝对路径，例如 node' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数数组，不经过 shell 解析' },
        cwd: { type: 'string', description: '相对工作区的执行目录，缺省为工作区根' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: '额外环境变量，只允许 envAllowlist 中的键' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    riskLevel: 'dangerous',
  },
  async execute(args, context) {
    const command = readNonEmptyString(args.command, 'command');
    const rawArgs = Array.isArray(args.args) ? args.args : [];
    if (rawArgs.some((item) => typeof item !== 'string')) throw new Error('args 必须是字符串数组');
    const env =
      args.env && typeof args.env === 'object' && !Array.isArray(args.env)
        ? Object.fromEntries(Object.entries(args.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : undefined;
    return commandExecutor.execute(
      { command, args: rawArgs, cwd: typeof args.cwd === 'string' ? args.cwd : undefined, env },
      context?.abortSignal,
      context?.workspaceDir,
    );
  },
});
toolRegistry.setEnabled('execute_command', config.sandbox.commandExecutionEnabled);

// ---- delegate_task（safe）：P7 子代理委托 ----
const DEFAULT_SUBAGENT_TOOLS = ['list_directory', 'open_file', 'scroll', 'search_grep', 'get_current_time'];

toolRegistry.register({
  descriptor: {
    name: 'delegate_task',
    description:
      '将独立子任务委托给另一个 Agent 执行。适用于：' +
      '同时搜索多个目录、并发读取多个文件、独立子分析。' +
      '子代理默认只有只读权限，无权写入文件。' +
      '可同时发起多个 delegate_task 调用实现并行子代理。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '子任务的简要目标（一句话）' },
        prompt: { type: 'string', description: '给子代理的详细指令' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: `允许子代理使用的工具（默认只有只读工具：${DEFAULT_SUBAGENT_TOOLS.join(', ')}）`,
        },
      },
      required: ['goal', 'prompt'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
    executionPolicy: { parallelizable: true },
  },
  async execute(args, context) {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!goal || !prompt) throw new Error('goal 和 prompt 必须是非空字符串');

    const tools = Array.isArray(args.tools)
      ? (args.tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    const result = await runSubTask({
      goal,
      prompt,
      allowedTools: tools,
      workspaceDir: context?.workspaceDir ?? process.cwd(),
    });

    return {
      ok: result.ok,
      subTaskGoal: goal,
      content: result.content,
      toolCallCount: result.toolCallCount,
      iterations: result.iterations,
      error: result.error,
      note: result.ok
        ? `子代理完成，${result.iterations} 轮，${result.toolCallCount} 次工具调用。`
        : `子代理失败：${result.error ?? '未知错误'}`,
    };
  },
});
// ---- index_files（safe）----
toolRegistry.register({
  descriptor: {
    name: 'index_files',
    description:
      '索引指定目录中的代码/文档文件到知识库，支持语义搜索。' +
      '对新增/变更文件做分块 + 向量化，已删除文件自动清理。' +
      '需要先配置 embedding provider（如 Ollama/nomic-embed-text）。',
    inputSchema: {
      type: 'object',
      properties: {
        dirs: { type: 'array', items: { type: 'string' }, description: '待索引目录列表（默认使用已配置目录）' },
        force: { type: 'boolean', description: '是否强制重新索引所有文件（默认 false，仅增量）' },
      },
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args) {
    const { indexKbDirs } = await import('../knowledge-base/index.js');
    const dirs = Array.isArray(args.dirs) ? args.dirs.filter((d) => typeof d === 'string') : undefined;
    const force = args.force === true;
    const results = await indexKbDirs(dirs, force);
    const total = results.reduce((s, r) => s + r.indexed, 0);
    const totalChunks = results.reduce((s, r) => s + r.totalChunks, 0);
    const removed = results.reduce((s, r) => s + r.removed, 0);
    return {
      indexed: total,
      totalChunks,
      removed,
      details: results,
      note: total > 0
        ? `已索引 ${total} 个文件（${totalChunks} 个文本块）`
        : '无变更，全部跳过',
    };
  },
});

// ---- recall（safe）----
toolRegistry.register({
  descriptor: {
    name: 'recall',
    description:
      '从知识库中语义搜索与当前任务相关的文件片段。' +
      '使用向量相似度匹配，需要先配置 embedding provider 并索引文件。' +
      '返回结果包含文件路径、内容片段和相关度评分。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或自然语言描述' },
        topK: { type: 'number', description: '返回结果数（默认 5）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args) {
    const { recallKb } = await import('../knowledge-base/index.js');
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query 不能为空');
    const topK = typeof args.topK === 'number' && args.topK > 0 ? Math.min(args.topK, 20) : 5;
    const { results, citations } = await recallKb(query, topK);
    if (results.length === 0) {
      return {
        found: 0,
        results: [],
        citations: [],
        note: '未找到匹配结果。请先添加知识库目录并通过 index_files 工具索引文件，或检查 embedding provider 配置。',
      };
    }
    return {
      found: results.length,
      results: results.map((r) => ({
        file: r.filePath,
        snippet: r.content,
        score: Math.round(r.score * 100) / 100,
      })),
      citations,
      note: `找到 ${results.length} 个相关片段`,
    };
  },
});

// ---- run_dreams（safe）----
toolRegistry.register({
  descriptor: {
    name: 'run_dreams',
    description:
      '执行记忆后台维护：补全向量索引、合并重复记忆、自动禁用低置信度记忆。' +
      '通常在任务结束后自动触发，也可手动调用查看维护报告。',
    inputSchema: {
      type: 'object',
      properties: {
        backfillEmbeddings: { type: 'boolean', description: '是否补全缺失的向量索引（默认 true）' },
        dedupMerge: { type: 'boolean', description: '是否合并相似重复记忆（默认 true）' },
        lowConfidenceSweep: { type: 'boolean', description: '是否禁用低置信度记忆（默认 true）' },
      },
      additionalProperties: false,
    },
    riskLevel: 'safe',
  },
  async execute(args) {
    const { runDreams } = await import('../memory/dreams.js');
    const options = {
      backfillEmbeddings: args.backfillEmbeddings !== false,
      dedupMerge: args.dedupMerge !== false,
      lowConfidenceSweep: args.lowConfidenceSweep !== false,
    };
    const report = await runDreams(options);
    return {
      ...report,
      note: report.errors.length > 0
        ? `维护完成（${report.durationMs}ms），${report.errors.length} 个错误`
        : `维护完成（${report.durationMs}ms），无错误`,
    };
  },
});
