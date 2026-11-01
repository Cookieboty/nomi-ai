/**
 * D4 的处理函数（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D4。契约声明在 packages/contract/src/app/knowledge.ts；这里：
 * - `createKnowledgeHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE）。服务直接发布契约事件。
 *
 * 服务抛的 `KbError` / `MemError` / `SchedError` 带旧码（`not-found`）：这里换成契约里声明的
 * `<前缀>_<旧码大写>`（`MEM_NOT_FOUND`）；其余异常照常抛出（INTERNAL，消息原样带给视图）。
 */

import { APP_DOMAINS, type KnowledgeProcedureName } from '@nomi-ai/contract/app';

import { need, type AppHandlerContext, type ContractDeps, type DomainHandlers } from './types';

export type KnowledgeHandlers = DomainHandlers<KnowledgeProcedureName>;

type ErrorPrefix = 'KB' | 'MEM' | 'SCHED' | 'TASKS';
type AppErrorCode = Parameters<AppHandlerContext['fail']>[0];

const DECLARED: ReadonlySet<string> = new Set<string>(APP_DOMAINS.knowledge.errors);

/** 服务错误的旧码 → 契约错误码；没声明的（含 ENOENT 这类系统错误）返回 null，原样抛出 */
export function knowledgeErrorCode(prefix: ErrorPrefix, err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  const mapped = `${prefix}_${code.toUpperCase().replace(/-/g, '_')}`;
  return DECLARED.has(mapped) ? mapped : null;
}

/** 跑一次服务调用；带业务码的服务错误转成 `ctx.fail(<声明的码>, message)` */
async function mapped<T>(
  prefix: ErrorPrefix,
  ctx: Pick<AppHandlerContext, 'fail'>,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const code = knowledgeErrorCode(prefix, err);
    if (code) ctx.fail(code as AppErrorCode, (err as Error).message);
    throw err;
  }
}

/**
 * 服务的返回类型多是 interface（没有索引签名），契约输出是 `z.looseObject`（带 `[k: string]: unknown`），
 * TS 不认两者兼容；形状由契约在运行时校验（BAD_OUTPUT），这里只在类型上放行。
 */
const out = <T>(v: unknown): T => v as T;

export function createKnowledgeHandlers(deps: ContractDeps): KnowledgeHandlers {
  const s = deps.services;
  const kb = () => need(s.kb, 'kb');
  const mem = () => need(s.mem, 'mem');
  const sched = () => need(s.sched, 'sched');
  const tasks = () => need(s.tasks, 'tasks');
  const conns = () => need(s.connections, 'connections');
  /** ConnectionError(code) → CONNECTIONS_<CODE>；not_allowed 不会经契约出现 */
  const connCall = async <T>(ctx: Pick<AppHandlerContext, 'fail'>, run: () => Promise<T> | T) => {
    try {
      return await run();
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const mapped = typeof code === 'string' ? `CONNECTIONS_${code.toUpperCase()}` : '';
      if (DECLARED.has(mapped)) ctx.fail(mapped as AppErrorCode, (err as Error).message);
      throw err;
    }
  };
  const local = () => need(s.localModels, 'localModels');
  const hub = () => need(s.localHub, 'localHub');
  const ext = () => need(s.ext, 'ext');

  return {
    // ---------- kb ----------
    'kb.state': () => out(kb().state()),
    'kb.docs': ({ sourceId, filter }) => out(kb().docs(sourceId, filter ?? '')),
    'kb.addFolder': (_i, ctx) => mapped('KB', ctx, async () => out(await kb().addFolder())),
    'kb.removeSource': ({ id }) => kb().removeSource(id),
    'kb.toggleSource': ({ id, enabled }) => kb().setSourceEnabled(id, enabled),
    'kb.setSettings': (patch) => out(kb().setSettings(patch)),
    'kb.consentCloud': ({ providerId }) => kb().consentCloud(providerId),
    'kb.test': ({ kind }) => kb().testEndpoint(kind),
    'kb.reindex': ({ force }) => out(kb().startReindex(force === true)),
    'kb.cancel': () => kb().cancelIndex(),
    'kb.clear': () => kb().clear(),
    'kb.search': async ({ q }) => out(await kb().search(q)),
    'kb.ask': ({ q, history }, ctx) =>
      mapped('KB', ctx, async () => out(await kb().askFromView(q, history ?? []))),
    'kb.open': ({ docId, how }) => kb().open(docId, how ?? 'open'),
    'kb.ocrDownload': ({ id }) => kb().downloadOcr(id),
    'kb.ocrCancel': ({ id }) => kb().cancelOcr(id),
    'kb.ocrRemove': ({ id }) => kb().removeOcr(id),

    // ---------- mem ----------
    'mem.state': () => out(mem().state()),
    'mem.list': ({ filter }) => out(mem().list(filter ?? '')),
    'mem.setSettings': (patch) => out(mem().setSettings(patch)),
    'mem.persona': () => mem().persona(),
    'mem.setPersona': ({ text }) => mem().setPersona(text),
    'mem.openPersona': () => mem().openPersona(),
    'mem.ingest': ({ conversationId, messages, force }, ctx) =>
      mapped('MEM', ctx, async () =>
        out(await mem().ingestFromView(conversationId, messages, force === true)),
      ),
    'mem.context': async ({ q }) => out(await mem().context(q.slice(0, 4000))),
    'mem.updateEpisode': ({ id, patch }, ctx) =>
      mapped('MEM', ctx, async () => out(await mem().updateEpisode(id, patch))),
    'mem.upsertFact': (input, ctx) =>
      mapped('MEM', ctx, async () => out(await mem().upsertFact(input))),
    'mem.remove': ({ kind, id }) => mem().remove(kind, id),
    'mem.clear': () => mem().clearAll(),
    'mem.backfill': () => mem().backfillVectors(),
    'mem.profile': () => out(mem().profile() ?? null),
    'mem.resetProfile': () => mem().resetProfile(),
    'mem.export': ({ format }) => mem().exportToFile(format),

    // ---------- sched ----------
    'sched.state': () => out(sched().state()),
    'sched.setSettings': (patch) => out(sched().setSettings(patch)),
    'sched.upsertTask': (task, ctx) => mapped('SCHED', ctx, () => out(sched().upsertTask(task))),
    'sched.toggleTask': ({ id, enabled }) => sched().setTaskEnabled(id, enabled),
    'sched.removeTask': ({ id }) => sched().removeTask(id),
    'sched.runTask': ({ id }, ctx) =>
      mapped('SCHED', ctx, async () => out(await sched().runTask(id, { manual: true }))),
    'sched.results': () => out(sched().results()),
    'sched.clearResults': () => sched().clearResults(),
    'sched.proactiveNow': (_i, ctx) => mapped('SCHED', ctx, () => sched().proactiveNow()),
    'sched.activity': () => {
      sched().noteActivity();
      return true;
    },

    // ---------- tasks ----------
    'tasks.list': () => out(tasks().list()),
    'tasks.get': ({ id }) => out(tasks().get(id)),
    'tasks.inbox': () => out(tasks().inbox()),
    'tasks.journal': ({ id }) => out(tasks().journal(id)),
    'tasks.create': (input, ctx) => mapped('TASKS', ctx, () => out(tasks().create(input))),
    'tasks.update': ({ id, ...patch }, ctx) =>
      mapped('TASKS', ctx, () => {
        const task = tasks().update(id, patch);
        if (!task) ctx.fail('TASKS_NOT_FOUND', id);
        return out(task);
      }),
    'tasks.grant': ({ id, grant }) => tasks().command(id, { type: 'grant', grant }),
    'tasks.revoke': ({ id }) => tasks().command(id, { type: 'revoke' }),
    'tasks.pause': ({ id }) => tasks().command(id, { type: 'pause' }),
    'tasks.resume': ({ id }) => tasks().command(id, { type: 'resume' }),
    'tasks.cancel': ({ id }) => tasks().command(id, { type: 'cancel' }),
    'tasks.runNow': ({ id }) => tasks().command(id, { type: 'runNow' }),
    'tasks.decide': ({ id, ...d }) => tasks().command(id, { type: 'decide', ...d }),
    'tasks.accept': ({ id }) => tasks().command(id, { type: 'accept' }),
    'tasks.reject': ({ id, feedback }) => tasks().command(id, { type: 'reject', feedback }),
    'tasks.reconcile': ({ id, outcome }) => tasks().command(id, { type: 'reconcile', outcome }),
    'tasks.remove': ({ id }) => tasks().remove(id),
    'tasks.events': ({ id }) => ({
      observed: out(tasks().events.observed(id)),
      ...tasks().events.status(id),
      sources: tasks().events.sourceIds(),
    }),
    'tasks.processObserved': ({ id }) => tasks().events.processObserved(id),
    'tasks.clearObserved': ({ id }) => {
      tasks().events.clearObserved(id);
      return true;
    },
    'tasks.setMode': ({ id, mode }) => out(tasks().setMode(id, mode)),
    'tasks.applyWorktree': async ({ id }) =>
      tasks().applyWorktree(
        id,
        async (dest) => !!s.desktop && (await s.desktop.broker.guard(dest, 'write', true)).ok,
      ),

    // ---------- connections ----------
    'connections.list': () => out(conns().list()),
    'connections.detect': ({ host }, ctx) =>
      connCall(ctx, async () => out(await conns().detect(host))),
    'connections.addGithub': (input, ctx) =>
      connCall(ctx, async () => out(await conns().addGithub(input))),
    'connections.check': ({ id }, ctx) => connCall(ctx, async () => out(await conns().check(id))),
    'connections.remove': ({ id }) => conns().remove(id),

    // ---------- local ----------
    'local.state': () => out(local().state()),
    'local.setSettings': (patch) => out(local().setSettings(out(patch))),
    'local.download': ({ id }) => local().download(id),
    'local.downloadRuntime': () => local().downloadRuntime(),
    'local.cancel': ({ id }) => local().cancel(id),
    'local.remove': ({ id }) => local().remove(id),
    'local.removeRuntime': () => local().removeRuntime(),
    'local.start': ({ id }) => local().start(id),
    'local.stop': () => local().stop(),
    'local.use': () => local().useAsChat(),
    'local.offline': ({ enabled }) => local().setOffline(enabled),
    'local.ollamaList': async () => out(await local().ollamaList()),
    'local.ollamaPull': ({ name }) => local().ollamaPull(name),
    'local.ollamaDelete': ({ name }) => local().ollamaDelete(name),

    // ---------- hub ----------
    'hub.export': async ({ include, conversations }) =>
      out(await hub().exportAll({ include, conversations })),

    // ---------- ext ----------
    'ext.mcpList': () => out(ext().listMcp()),
    'ext.mcpUpsert': (server) => out(ext().upsert(out(server))),
    'ext.mcpRemove': ({ id }) => ext().remove(id),
    'ext.mcpToggle': ({ id, enabled }) => ext().toggle(id, enabled),
    'ext.mcpConnect': async ({ id }) => out(await ext().connect(id)),
    'ext.mcpDisconnect': ({ id }) => ext().disconnect(id),
    'ext.mcpImport': ({ text }) => out(ext().importJson(text)),
    'ext.skillsList': () => out(ext().listSkills()),
    'ext.skillGet': ({ name }) => out(ext().getSkill(name)),
    'ext.skillSave': (p) => out(ext().saveSkill(out(p))),
    'ext.skillRemove': ({ name }) => ext().removeSkill(name),
    'ext.skillToggle': ({ name, enabled }) => ext().toggleSkill(name, enabled),
    'ext.skillImport': async () => out(await ext().importSkillDialog()),
    'ext.skillOpen': ({ name }) => ext().openSkill(name),
    'ext.skillsContext': () => ext().skillsContext(),
    'ext.migrateScan': async ({ pickProject, clearProject }) =>
      out(await ext().migrateScan({ pickProject: !!pickProject, clearProject: !!clearProject })),
    'ext.migrateImport': async ({ items }) => out(await ext().migrateImport(out(items))),
  };
}
