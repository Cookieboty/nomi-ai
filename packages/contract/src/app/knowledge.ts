/**
 * D4 · 知识库 / 记忆 / 日程 / 本地模型 / 扩展（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D4：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：kb、mem、sched、local、hub、ext（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:kb:*`、`ai:mem:*`、`ai:sched:*`
 * - `ai:local:*`（LocalModelService，通道名由 `ai:local:${ch}` 拼出）、`ai:hub:export`
 * - `ai:ext:*`（ExtensionsService，通道名由 `ai:ext:${ch}` 拼出）
 *
 * 旧通道都在 `window.aiIPC` 上（两个窗口都有），所以这里不写 `surfaces`。位置参数改成具名对象
 * （`ai:kb:toggle-source(id, enabled)` → `kb.toggleSource({ id, enabled })`）；原来就是一个对象的
 * 补丁（`set-settings`、`upsert-task` 等）直接作为入参。
 *
 * 约定见设计稿 §12「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`。
 */

import { z } from 'zod';

import type { EventMap, ProcedureMap } from '../contract';

import {
  ChatTurn,
  HubExportResult,
  KbDocView,
  KbDownloadEvent,
  KbHit,
  KbProgress,
  KbSettings,
  KbSettingsPatch,
  KbSource,
  KbSourceRef,
  KbState,
  LocalProgressEvent,
  LocalSettings,
  LocalSettingsPatch,
  LocalState,
  McpList,
  McpLive,
  McpServerEntry,
  McpServerInput,
  MemEpisode,
  MemEpisodePatch,
  MemFact,
  MemFactInput,
  MemSettings,
  MemSettingsPatch,
  MemState,
  MemUsed,
  MigrateChoice,
  MigrateImportResult,
  MigrateScanResult,
  OkResult,
  OllamaModel,
  SchedSettings,
  SchedSettingsPatch,
  SchedState,
  SchedTask,
  SchedTaskInput,
  SkillDoc,
  SkillInfo,
  SkillMeta,
  TaskResult,
} from './knowledge/schemas';

const none = z.void();
const id = z.object({ id: z.string() });
const name = z.object({ name: z.string() });
const ok = z.boolean();

export const knowledgeProcedures = {
  // ---------- kb：本地知识库（KnowledgeService） ----------
  'kb.state': { kind: 'query', input: none, output: KbState },
  'kb.docs': {
    kind: 'query',
    input: z.object({ sourceId: z.string(), filter: z.string().optional() }),
    output: z.array(KbDocView),
  },
  /** 主进程弹系统选择框；取消时为 null */
  'kb.addFolder': { kind: 'mutation', input: none, output: KbSource.nullable() },
  'kb.removeSource': { kind: 'mutation', input: id, output: ok },
  'kb.toggleSource': {
    kind: 'mutation',
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: ok,
  },
  'kb.setSettings': { kind: 'mutation', input: KbSettingsPatch, output: KbSettings },
  /** 同意把文件片段发给云端 provider 做向量 / 重排 */
  'kb.consentCloud': {
    kind: 'mutation',
    input: z.object({ providerId: z.string() }),
    output: ok,
    dangerous: true,
  },
  'kb.test': {
    kind: 'mutation',
    input: z.object({ kind: z.enum(['embed', 'rerank']) }),
    output: z.looseObject({ ok: z.boolean(), message: z.string() }),
  },
  /** 后台开始重建索引，立即返回当前进度（之后的进度经 `kb.progress` 推送） */
  'kb.reindex': {
    kind: 'mutation',
    input: z.object({ force: z.boolean().optional() }),
    output: KbProgress,
  },
  'kb.cancel': { kind: 'mutation', input: none, output: ok },
  'kb.clear': { kind: 'mutation', input: none, output: ok },
  'kb.search': {
    kind: 'query',
    input: z.object({ q: z.string() }),
    output: z.looseObject({ hits: z.array(KbHit), mode: z.string() }),
  },
  'kb.ask': {
    kind: 'mutation',
    input: z.object({ q: z.string(), history: z.array(ChatTurn).optional() }),
    output: z.looseObject({
      answer: z.string(),
      sources: z.array(KbSourceRef),
      mode: z.string(),
    }),
  },
  'kb.open': {
    kind: 'mutation',
    input: z.object({ docId: z.string(), how: z.enum(['open', 'reveal']).optional() }),
    output: OkResult,
  },
  'kb.ocrDownload': { kind: 'mutation', input: id, output: OkResult },
  'kb.ocrCancel': { kind: 'mutation', input: id, output: ok },
  'kb.ocrRemove': { kind: 'mutation', input: id, output: ok },

  // ---------- mem：长期记忆（MemoryService） ----------
  'mem.state': { kind: 'query', input: none, output: MemState },
  'mem.list': {
    kind: 'query',
    input: z.object({ filter: z.string().optional() }),
    output: z.looseObject({ episodes: z.array(MemEpisode), facts: z.array(MemFact) }),
  },
  'mem.setSettings': { kind: 'mutation', input: MemSettingsPatch, output: MemSettings },
  'mem.persona': { kind: 'query', input: none, output: z.string() },
  'mem.setPersona': { kind: 'mutation', input: z.object({ text: z.string() }), output: ok },
  'mem.openPersona': { kind: 'mutation', input: none, output: ok },
  /** 摘要一段会话（新建 / 更新情节，或返回跳过原因） */
  'mem.ingest': {
    kind: 'mutation',
    input: z.object({
      conversationId: z.string(),
      messages: z.array(ChatTurn),
      force: z.boolean().optional(),
    }),
    output: z.looseObject({ episode: MemEpisode.optional(), skipped: z.string().optional() }),
  },
  /** 召回片段（注入对话 system） */
  'mem.context': {
    kind: 'query',
    input: z.object({ q: z.string() }),
    output: z.looseObject({ text: z.string(), used: z.array(MemUsed) }),
  },
  'mem.updateEpisode': {
    kind: 'mutation',
    input: z.object({ id: z.string(), patch: MemEpisodePatch }),
    output: MemEpisode,
  },
  'mem.upsertFact': { kind: 'mutation', input: MemFactInput, output: MemFact },
  'mem.remove': {
    kind: 'mutation',
    input: z.object({ kind: z.enum(['episode', 'fact']), id: z.string() }),
    output: ok,
  },
  'mem.clear': { kind: 'mutation', input: none, output: ok },
  /** 给缺向量的条目补向量，返回补了多少条 */
  'mem.backfill': { kind: 'mutation', input: none, output: z.number() },
  /** AI 门面的用户画像（没有时为 null） */
  'mem.profile': {
    kind: 'query',
    input: none,
    output: z.record(z.string(), z.unknown()).nullable(),
  },
  'mem.resetProfile': { kind: 'mutation', input: none, output: ok },
  /** 主进程弹保存对话框；取消时 `{ ok: false }` */
  'mem.export': {
    kind: 'mutation',
    input: z.object({ format: z.enum(['json', 'md']) }),
    output: z.looseObject({ ok: z.boolean(), path: z.string().optional() }),
  },

  // ---------- sched：主动日程（SchedulerService） ----------
  'sched.state': { kind: 'query', input: none, output: SchedState },
  'sched.setSettings': { kind: 'mutation', input: SchedSettingsPatch, output: SchedSettings },
  'sched.upsertTask': { kind: 'mutation', input: SchedTaskInput, output: SchedTask },
  'sched.toggleTask': {
    kind: 'mutation',
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: ok,
  },
  'sched.removeTask': { kind: 'mutation', input: id, output: ok },
  /** 立即运行（手动） */
  'sched.runTask': { kind: 'mutation', input: id, output: TaskResult },
  'sched.results': { kind: 'query', input: none, output: z.array(TaskResult) },
  'sched.clearResults': { kind: 'mutation', input: none, output: ok },
  /** 立即主动搭话一次，返回说的话（没想到说什么时 SCHED_EMPTY） */
  'sched.proactiveNow': { kind: 'mutation', input: none, output: z.string() },
  /** 用户刚在对话里活动过（主动搭话据此避让） */
  'sched.activity': { kind: 'mutation', input: none, output: ok },

  // ---------- local：本机模型（LocalModelService） ----------
  'local.state': { kind: 'query', input: none, output: LocalState },
  'local.setSettings': { kind: 'mutation', input: LocalSettingsPatch, output: LocalSettings },
  'local.download': { kind: 'mutation', input: id, output: OkResult },
  'local.downloadRuntime': { kind: 'mutation', input: none, output: OkResult },
  'local.cancel': { kind: 'mutation', input: id, output: ok },
  'local.remove': { kind: 'mutation', input: id, output: ok },
  'local.removeRuntime': { kind: 'mutation', input: none, output: ok },
  'local.start': {
    kind: 'mutation',
    input: id,
    output: z.looseObject({ baseURL: z.string(), providerId: z.string() }),
  },
  'local.stop': { kind: 'mutation', input: none, output: ok },
  /** 设为当前对话模型 */
  'local.use': { kind: 'mutation', input: none, output: ok },
  /** 离线模式（只用本地模型）：改的是隐私开关（同 desktop 的 local-only），返回改后的状态 */
  'local.offline': {
    kind: 'mutation',
    input: z.object({ enabled: z.boolean() }),
    output: ok,
    dangerous: true,
  },
  'local.ollamaList': { kind: 'query', input: none, output: z.array(OllamaModel) },
  'local.ollamaPull': { kind: 'mutation', input: name, output: ok },
  'local.ollamaDelete': { kind: 'mutation', input: name, output: ok },

  // ---------- hub：数据导出（LocalHubService） ----------
  /**
   * 主进程弹保存对话框，打包本地数据；取消时为 null。
   * `conversations` 是视图 localStorage 里的会话（不透明的 JSON，原样写进包）。
   */
  'hub.export': {
    kind: 'mutation',
    input: z.object({ include: z.array(z.string()), conversations: z.unknown().optional() }),
    output: HubExportResult.nullable(),
  },

  // ---------- ext：MCP 服务器 + 技能包（ExtensionsService） ----------
  /*
   * MCP 服务器的授权（§8「授予权限的过程写 dangerous」）：新建 / 修改决定了启动什么命令、连哪个地址、带哪些
   * 密钥，以及信任级别（`auto` = 工具调用不再确认）；启用 / 连接让 AI 能调用它的工具（连接时还会启动配置的
   * 命令）。这三个只接受受信调用者。删除、断开只收回能力；导入（JSON / 迁移）一律是 `ask`、默认不连，都不算。
   */
  'ext.mcpList': { kind: 'query', input: none, output: McpList },
  'ext.mcpUpsert': {
    kind: 'mutation',
    input: McpServerInput,
    output: McpServerEntry,
    dangerous: true,
  },
  'ext.mcpRemove': { kind: 'mutation', input: id, output: ok },
  'ext.mcpToggle': {
    kind: 'mutation',
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: ok,
    dangerous: true,
  },
  'ext.mcpConnect': { kind: 'mutation', input: id, output: McpLive, dangerous: true },
  'ext.mcpDisconnect': { kind: 'mutation', input: id, output: z.void() },
  /** 从 JSON（其他客户端的 mcpServers 配置）导入，导入后默认不连 */
  'ext.mcpImport': {
    kind: 'mutation',
    input: z.object({ text: z.string() }),
    output: z.array(McpServerEntry),
  },
  'ext.skillsList': { kind: 'query', input: none, output: z.array(SkillInfo) },
  'ext.skillGet': { kind: 'query', input: name, output: SkillDoc },
  'ext.skillSave': {
    kind: 'mutation',
    input: z.object({ meta: SkillMeta, body: z.string(), originalName: z.string().optional() }),
    output: SkillMeta,
  },
  'ext.skillRemove': { kind: 'mutation', input: name, output: ok },
  'ext.skillToggle': {
    kind: 'mutation',
    input: z.object({ name: z.string(), enabled: z.boolean() }),
    output: ok,
  },
  /** 主进程弹选择文件夹；取消时为 null */
  'ext.skillImport': { kind: 'mutation', input: none, output: SkillMeta.nullable() },
  /** 在系统文件管理器里打开技能目录（不给名字 = 技能根目录）；返回系统的错误信息（成功为空串） */
  'ext.skillOpen': {
    kind: 'mutation',
    input: z.object({ name: z.string().optional() }),
    output: z.string(),
  },
  /** 注入对话 system 的技能目录 */
  'ext.skillsContext': { kind: 'query', input: none, output: z.string() },
  /** 扫描 Claude Code / Codex 里可导入的 MCP 与技能；`pickProject` 时主进程弹选择文件夹 */
  'ext.migrateScan': {
    kind: 'mutation',
    input: z.object({
      pickProject: z.boolean().optional(),
      clearProject: z.boolean().optional(),
    }),
    output: MigrateScanResult,
  },
  'ext.migrateImport': {
    kind: 'mutation',
    input: z.object({ items: z.array(MigrateChoice) }),
    output: MigrateImportResult,
  },
} as const satisfies ProcedureMap;

export const knowledgeEvents = {
  /** 知识库来源 / 设置 / 索引变了（payload 恒为 null，收到后重新拉 `kb.state`） */
  'kb.changed': z.null(),
  /** 索引进度 */
  'kb.progress': KbProgress,
  /** OCR 语言包下载进度（phase：start / progress / done / error 等） */
  'kb.download': KbDownloadEvent,
  'mem.changed': z.null(),
  /** 正在摘要的会话 */
  'mem.status': z.looseObject({ busy: z.array(z.string()) }),
  'sched.changed': z.null(),
  /** 任务跑完（到点 / 补跑 / 手动） */
  'sched.result': TaskResult,
  /** 主动搭话 */
  'sched.proactive': z.looseObject({ text: z.string(), at: z.number() }),
  'local.changed': z.null(),
  /** 模型 / 运行时下载、Ollama 拉取的进度 */
  'local.progress': LocalProgressEvent,
  'ext.changed': z.null(),
} as const satisfies EventMap;

/**
 * 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出。
 * 来自服务的 `KbError` / `MemError` / `SchedError`：旧码加前缀转大写（`not-found` → `MEM_NOT_FOUND`）。
 */
export const knowledgeErrors = [
  'KB_DENIED',
  'KB_EMPTY',
  'KB_LOCAL_ONLY',
  'KB_USER_DENIED',
  'KB_OCR_MISSING',
  'MEM_BAD_SUMMARY',
  'MEM_SUMMARIZE_FAILED',
  'MEM_NOT_FOUND',
  'MEM_EMPTY',
  'SCHED_INVALID',
  'SCHED_NOT_FOUND',
  'SCHED_BUSY',
  'SCHED_EMPTY',
] as const satisfies readonly string[];

export type KnowledgeProcedureName = keyof typeof knowledgeProcedures & string;
export type KnowledgeEventName = keyof typeof knowledgeEvents & string;
