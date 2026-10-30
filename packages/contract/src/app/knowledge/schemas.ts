/**
 * D4 的 zod schema（知识库 / 记忆 / 日程 / 本地模型 / 数据导出 / 扩展）。
 *
 * 照主进程服务的返回类型（core/src/{knowledge,memory,schedule,local,extensions}）与视图客户端
 * （ai-chat/src/services/{kb,mem,sched,local,ext}Client.ts）的接口写。字段多、会演进的返回值一律
 * `z.looseObject`（未知字段透传，与原 IPC 一致）；补丁类入参也用 `z.looseObject`，由服务自己清洗。
 */

import { z } from 'zod';

const str = z.string();
const num = z.number();
const bool = z.boolean();

/** `{ ok, error? }`：下载 / 打开这类「失败不抛错」的结果 */
export const OkResult = z.looseObject({ ok: bool, error: str.optional() });

/** 下载进度（字节） */
export const ByteProgress = z.looseObject({ received: num, total: num });

// ---------------------------------------------------------------------------
// kb：本地知识库
// ---------------------------------------------------------------------------

export const KbModelRef = z.looseObject({ enabled: bool, providerId: str, model: str });

export const KbSettings = z.looseObject({
  embed: KbModelRef,
  rerank: KbModelRef,
  ocr: z.looseObject({ enabled: bool, langs: z.array(str) }),
  cloudConsent: z.array(str),
  topK: num,
});

/** setSettings 的补丁：服务按字段校验，未知字段忽略 */
export const KbSettingsPatch = z.looseObject({
  embed: KbModelRef.partial().optional(),
  rerank: KbModelRef.partial().optional(),
  ocr: z.looseObject({ enabled: bool.optional(), langs: z.array(str).optional() }).optional(),
  cloudConsent: z.array(str).optional(),
  topK: num.optional(),
});

export const KbSource = z.looseObject({
  id: str,
  kind: z.literal('folder'),
  path: str.optional(),
  addedAt: num,
  enabled: bool,
});

export const KbSourceView = KbSource.extend({
  docs: num,
  chunks: num,
  errors: num,
  lastIndexed: num,
});

export const KbProgress = z.looseObject({
  running: bool,
  phase: z.enum(['scan', 'index', 'done', 'cancelled', 'error', 'idle']),
  done: num,
  total: num,
  current: str.optional(),
  added: num,
  updated: num,
  removed: num,
  failed: num,
  error: str.optional(),
});

export const KbOcrAsset = z.looseObject({
  id: str,
  lang: str,
  name: str,
  installed: bool,
  downloading: ByteProgress.nullable(),
});

export const KbState = z.looseObject({
  settings: KbSettings,
  sources: z.array(KbSourceView),
  stats: z.looseObject({ docs: num, chunks: num, vectors: num }),
  progress: KbProgress,
  embedStatus: z.looseObject({ active: bool, reason: str.optional() }),
  localOnly: bool,
  providers: z.array(z.looseObject({ id: str, name: str, baseURL: str, local: bool })),
  ocr: z.array(KbOcrAsset),
});

export const KbDocView = z.looseObject({
  id: str,
  path: str,
  title: str,
  ext: str,
  status: z.enum(['ok', 'error', 'empty']),
  error: str.optional(),
  chunks: num,
  ocr: bool,
  vectors: bool,
  indexedAt: num,
  size: num,
});

export const KbHit = z.looseObject({
  chunkId: str,
  docId: str,
  path: str,
  title: str,
  page: num.optional(),
  text: str,
  score: num,
});

export const KbSourceRef = z.looseObject({
  n: num,
  docId: str,
  chunkId: str,
  path: str,
  title: str,
  page: num.optional(),
  snippet: str,
});

/** 问答历史：服务只保留 user / assistant 的文本消息并截断 */
export const ChatTurn = z.looseObject({ role: str, content: str });

export const KbDownloadEvent = z.looseObject({
  id: str,
  received: num,
  total: num,
  phase: str,
  error: str.optional(),
});

// ---------------------------------------------------------------------------
// mem：长期记忆
// ---------------------------------------------------------------------------

export const FactKind = z.enum(['identity', 'preference', 'goal', 'dislike', 'habit', 'note']);

export const MemSettings = z.looseObject({
  enabled: bool,
  autoSummarize: bool,
  recall: bool,
  topK: num,
  minMessages: num,
});

export const MemSettingsPatch = z.looseObject({
  enabled: bool.optional(),
  autoSummarize: bool.optional(),
  recall: bool.optional(),
  topK: num.optional(),
  minMessages: num.optional(),
});

export const MemEpisode = z.looseObject({
  id: str,
  conversationId: str,
  title: str,
  summary: str,
  keywords: z.array(str),
  createdAt: num,
  updatedAt: num,
  messageCount: num,
  pinned: bool,
  edited: bool,
  vec: str.optional(),
});

export const MemFact = z.looseObject({
  id: str,
  kind: FactKind,
  text: str,
  source: z.enum(['distilled', 'user']),
  createdAt: num,
  updatedAt: num,
  vec: str.optional(),
});

/** 编辑补丁（服务清洗：只认标题 / 摘要 / 关键词 / 置顶 / 类型 / 正文） */
export const MemEpisodePatch = z.looseObject({
  title: str.optional(),
  summary: str.optional(),
  keywords: z.array(str).optional(),
  pinned: bool.optional(),
});

export const MemFactInput = z.looseObject({
  id: str.optional(),
  kind: str.optional(),
  text: str.optional(),
});

export const MemState = z.looseObject({
  settings: MemSettings,
  stats: z.looseObject({ episodes: num, facts: num, vectors: num }),
  busy: z.array(str),
  lastError: str,
  personaChars: num,
});

export const MemUsed = z.looseObject({ id: str, kind: str, title: str });

// ---------------------------------------------------------------------------
// sched：主动日程
// ---------------------------------------------------------------------------

export const RepeatRule = z.union([
  z.looseObject({ kind: z.literal('daily') }),
  z.looseObject({ kind: z.literal('weekdays') }),
  z.looseObject({ kind: z.literal('weekly'), days: z.array(num) }),
  z.looseObject({ kind: z.literal('monthly') }),
  z.looseObject({ kind: z.literal('interval'), minutes: num }),
]);

export const SchedSettings = z.looseObject({
  quiet: z.looseObject({ enabled: bool, start: str, end: str }),
  proactive: z.looseObject({
    enabled: bool,
    frequency: z.enum(['low', 'medium', 'high']),
    activeStart: str,
    activeEnd: str,
    skipIfChattedMin: num,
  }),
});

/** 设置补丁：每一组都可以只给部分字段，服务逐项校验 */
export const SchedSettingsPatch = z.looseObject({
  quiet: z.looseObject({}).optional(),
  proactive: z.looseObject({}).optional(),
});

export const SchedTask = z.looseObject({
  id: str,
  name: str,
  prompt: str,
  time: str,
  repeat: RepeatRule,
  enabled: bool,
  template: z.literal('briefing').optional(),
  nextRunAt: num,
  lastRunAt: num.optional(),
  lastStatus: z.enum(['ok', 'error', 'skipped']).optional(),
  lastError: str.optional(),
});

/** 新建 / 编辑任务：服务校验名称与内容，其余字段有默认值 */
export const SchedTaskInput = z.looseObject({
  id: str.optional(),
  name: str.optional(),
  prompt: str.optional(),
  time: str.optional(),
  repeat: RepeatRule.optional(),
  enabled: bool.optional(),
  template: z.literal('briefing').optional(),
});

export const TaskResult = z.looseObject({
  id: str,
  taskId: str,
  name: str,
  at: num,
  ok: bool,
  text: str,
  catchUp: bool.optional(),
});

export const SchedState = z.looseObject({
  settings: SchedSettings,
  tasks: z.array(SchedTask),
  running: z.array(str),
  quietNow: bool,
  deferred: num,
  proactive: z.looseObject({
    today: num,
    lastAt: num,
    gate: z.looseObject({ ok: bool, reason: str }),
  }),
});

// ---------------------------------------------------------------------------
// local：本机模型（llama.cpp / Ollama）与 hub：数据导出
// ---------------------------------------------------------------------------

export const LocalProgress = ByteProgress.extend({ status: str.optional() });

export const LocalSettings = z.looseObject({
  activeModel: str.optional(),
  autoStart: bool,
  providerId: str.optional(),
  threads: num.optional(),
  ollamaUrl: str,
});

export const LocalSettingsPatch = z.looseObject({
  autoStart: bool.optional(),
  threads: num.optional(),
  ollamaUrl: str.optional(),
});

export const LocalModel = z.looseObject({
  id: str,
  name: str,
  bytes: num,
  installed: bool,
  fit: z.enum(['ok', 'tight', 'too-big']),
  downloading: ByteProgress.optional(),
});

export const LocalState = z.looseObject({
  ramGb: num,
  recommended: str,
  models: z.array(LocalModel),
  runtime: z.looseObject({
    tag: str,
    supported: bool,
    bytes: num,
    installed: bool,
    downloading: ByteProgress.optional(),
  }),
  server: z.looseObject({
    status: z.enum(['stopped', 'starting', 'running', 'error']),
    model: str.optional(),
    port: num.optional(),
    baseURL: str.optional(),
    error: str.optional(),
    log: z.array(str),
  }),
  settings: LocalSettings,
  offline: bool,
});

export const OllamaModel = z.looseObject({
  name: str,
  size: num,
  modifiedAt: str,
  params: str.optional(),
  quant: str.optional(),
  family: str.optional(),
});

export const LocalProgressEvent = LocalProgress.extend({ id: str });

export const HubExportResult = z.looseObject({ file: str, files: num, bytes: num });

// ---------------------------------------------------------------------------
// ext：MCP 服务器 + 技能包 + 从 Claude Code / Codex 迁移
// ---------------------------------------------------------------------------

export const McpTransport = z.enum(['stdio', 'http', 'sse']);
export const McpTrust = z.enum(['ask', 'read-auto', 'auto']);
export const McpStatus = z.enum(['off', 'connecting', 'connected', 'error']);

export const McpTool = z.looseObject({
  name: str,
  description: str,
  readOnly: bool,
  dangerous: bool,
});

const stringMap = z.record(str, str);

/** 存盘的服务器配置（密钥已打码） */
export const McpServerEntry = z.looseObject({
  id: str,
  name: str,
  transport: McpTransport,
  command: str.optional(),
  args: z.array(str).optional(),
  url: str.optional(),
  env: stringMap.optional(),
  headers: stringMap.optional(),
  enabled: bool,
  trust: McpTrust,
});

export const McpServer = McpServerEntry.extend({
  status: McpStatus,
  error: str.optional(),
  tools: z.array(McpTool),
});

/** 新建 / 编辑：服务清洗并合并旧的密钥 */
export const McpServerInput = z.looseObject({
  id: str.optional(),
  name: str.optional(),
  transport: McpTransport.optional(),
  command: str.optional(),
  args: z.array(str).optional(),
  url: str.optional(),
  env: stringMap.optional(),
  headers: stringMap.optional(),
  enabled: bool.optional(),
  trust: McpTrust.optional(),
});

export const McpLive = z.looseObject({
  status: McpStatus,
  error: str.optional(),
  tools: z.array(McpTool),
  at: num.optional(),
});

export const McpList = z.looseObject({
  servers: z.array(McpServer),
  env: z.array(
    z.looseObject({ id: str, name: str, origin: str, status: McpStatus, tools: z.array(McpTool) }),
  ),
  presets: z.array(z.looseObject({ key: str, name: str, description: str })),
  ready: bool,
});

export const SkillMeta = z.looseObject({
  name: str,
  description: str,
  version: str.optional(),
  license: str.optional(),
  author: str.optional(),
});

export const SkillInfo = SkillMeta.extend({
  enabled: bool,
  builtin: bool,
  files: z.array(str),
  error: str.optional(),
  dir: str,
});

export const SkillDoc = z.looseObject({ meta: SkillMeta, body: str, files: z.array(str) });

export const MigrateScanResult = z.looseObject({
  project: str.nullable(),
  sources: z.array(z.looseObject({ tool: str, where: str, found: bool, error: str.optional() })),
  mcp: z.array(z.looseObject({ key: str, kind: z.literal('mcp'), name: str })),
  skills: z.array(z.looseObject({ key: str, kind: z.literal('skill'), name: str })),
});

export const MigrateChoice = z.looseObject({
  key: str,
  action: z.enum(['skip', 'rename', 'overwrite']).optional(),
});

export const MigrateImportResult = z.looseObject({
  imported: z.array(z.looseObject({ key: str, kind: z.enum(['mcp', 'skill']), name: str })),
  skipped: z.array(z.looseObject({ key: str, name: str })),
  failed: z.array(z.looseObject({ key: str, name: str, error: str })),
});
