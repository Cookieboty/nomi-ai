/**
 * D3 的处理函数（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D3。契约声明在 packages/contract/src/app/coding.ts；这里：
 * - `createCodingHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE）。服务直接发布契约事件。
 *
 * 编排器（HarnessOrchestrator）原来只把推送发给调过 ai:harness:* 的窗口；这里在建 router 与每次调用时把
 * 应用事件总线接给它（`attachEvents`），推送改为 `events.publish('harness.*', …, { surface: 'chat' })`。
 */

import type { CodingProcedureName } from '@nomi-ai/contract/app';

import { AccountError, parseAccountKind } from '../cli/accounts/AccountService';
import { toScope, toUpdatable } from '../cli/CliUpdateService';
import type { HarnessOrchestrator } from '../cli/harness/Orchestrator';
import type { SessionHistoryService } from '../cli/SessionHistoryService';
import type {
  HarnessBackend,
  HarnessImageInput,
  HarnessPermissionMode,
  HarnessTabMessage,
} from '../cli/types';

import { need, type AppHandlerContext, type ContractDeps, type DomainHandlers } from './types';

export type CodingHandlers = DomainHandlers<CodingProcedureName>;

type HistoryBackend = Parameters<SessionHistoryService['list']>[0];

/**
 * 服务返回的 interface 没有索引签名，契约里的 loose schema（输入类型带 `[k: string]: unknown`）
 * 收不下；Wire<T> 把它逐层改写成同样字段的对象字面量类型。只在类型上转换，运行时原样返回。
 */
type Wire<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { [K in keyof T]: Wire<T[K]> }
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
const wire = <T>(value: T): Wire<T> => value as Wire<T>;
const wireP = async <T>(value: Promise<T>): Promise<Wire<T>> => wire(await value);

/** AccountError 的 kebab code → 契约错误码（视图据此走控制流，不匹配文案） */
const ACCOUNT_CODES = {
  'not-found': 'ACCOUNT_NOT_FOUND',
  'in-use': 'ACCOUNT_IN_USE',
  local: 'ACCOUNT_LOCAL',
  unsupported: 'ACCOUNT_UNSUPPORTED',
  'unknown-live': 'ACCOUNT_UNKNOWN_LIVE',
} as const;

async function accountCall<T>(ctx: AppHandlerContext, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AccountError) ctx.fail(ACCOUNT_CODES[e.code], e.message);
    throw e;
  }
}

export function createCodingHandlers(deps: ContractDeps): CodingHandlers {
  const { services } = deps;
  /** 编排器的推送接到应用事件总线（同一实例只接一次） */
  let attached: HarnessOrchestrator | null = null;
  const harness = (): HarnessOrchestrator => {
    const h = need(services.harness, 'harness');
    if (attached !== h) {
      h.attachEvents(deps.events);
      attached = h;
    }
    return h;
  };
  if (services.harness) harness();

  const plugins = () => need(services.cliPlugins, 'cliPlugins');
  const accounts = () => need(services.accounts, 'accounts');
  const login = () => need(services.accountLogin, 'accountLogin');
  const updates = () => need(services.cliUpdate, 'cliUpdate');
  const delegate = () => need(services.delegate, 'delegate');
  const agents = () => need(services.agents, 'agents');
  const history = () => need(services.history, 'history');

  return {
    // ── harness：主标签 ──
    'harness.state': () => wireP(harness().stateFresh()),
    'harness.setBackend': ({ backend }) => wire(harness().setBackend(backend as HarnessBackend)),
    'harness.setCwd': ({ cwd, carry }) => wire(harness().setCwd(cwd, { carry: carry === true })),
    'harness.pickCwd': () => wireP(harness().pickCwd()),
    'harness.send': ({ prompt }) => wireP(harness().sendReply(prompt)),

    // ── harness：标签 ──
    'harness.tabs': () => wire(harness().listTabs()),
    'harness.tabCreate': (o) =>
      wire(harness().createTab(o as unknown as Parameters<HarnessOrchestrator['createTab']>[0])),
    'harness.tabSeed': ({ id, messages }) =>
      wire(harness().seedTabMessages(id, messages as unknown as HarnessTabMessage[])),
    'harness.tabClose': ({ id }) => wire(harness().closeTab(id)),
    'harness.tabRename': ({ id, title }) => wire(harness().renameTab(id, title)),
    'harness.tabActivate': ({ id }) => wire(harness().setActiveTab(id)),
    'harness.tabBackend': ({ id, backend }) =>
      wire(harness().setTabBackend(id, backend as HarnessBackend)),
    'harness.tabCwd': ({ id, cwd, carry }) =>
      wire(harness().setTabCwd(id, cwd, { carry: carry === true })),
    // 等长驻进程确认后再回复：后端拒绝 / 超时时界面拿到错误（#72）
    'harness.tabPermissionMode': ({ id, mode, confirmed, expect }) =>
      wireP(
        harness().applyTabPermissionMode(id, mode as HarnessPermissionMode, {
          confirmed: confirmed === true,
          expect,
        }),
      ),
    'harness.permissionDefaults': (o) =>
      wire(
        harness().setPermissionDefaults(
          o as {
            defaultPermissionMode?: HarnessPermissionMode;
            codexNetwork?: boolean;
            autoApprove?: boolean;
          },
        ),
      ),
    'harness.modelCatalog': ({ backend, refresh, source }) =>
      wireP(
        harness().modelCatalogFor(backend as HarnessBackend, {
          refresh: refresh === true,
          source: source === 'thirdParty' ? 'thirdParty' : 'official',
        }),
      ),
    'harness.tabSource': ({ id, source, model }) => wire(harness().setTabSource(id, source, model)),
    'harness.tabModel': ({ id, model, expectSource }) =>
      wire(harness().setTabModel(id, model, expectSource ? { expectSource } : {})),
    'harness.tabAccount': ({ id, accountId }) =>
      wire(harness().setTabAccount(id, accountId || null)),
    'harness.tabLongContext': ({ id, on }) => wire(harness().setTabLongContext(id, on)),
    'harness.tabEffort': ({ id, effort }) => wire(harness().setTabReasoningEffort(id, effort)),
    'harness.tabPickCwd': ({ id }) => wireP(harness().pickTabCwd(id)),
    'harness.tabCarryClear': ({ id }) => wire(harness().clearTabCarry(id)),
    'harness.tabRewind': ({ id, messageId }) => wireP(harness().rewindTab(id, messageId)),
    'harness.pickDir': ({ defaultPath }) => harness().pickDirectory(defaultPath || undefined),
    'harness.recentCwds': () => harness().recentCwds(),
    'harness.tabMessages': ({ id }) => wire(harness().tabMessages(id)),
    'harness.tabSend': ({ id, prompt, images }) =>
      wireP(harness().sendTabReply(id, prompt, images as HarnessImageInput[] | undefined)),
    'harness.tabCancel': ({ id }) => harness().cancelTab(id),
    'harness.stopAgent': ({ id, agentId }) => harness().stopAgent(id, agentId),
    'harness.tabContext': ({ id }) => wireP(harness().tabContext(id)),

    // ── harness：斜杠命令 / 右栏「改动」/ 工作区文件（cwd 由编排器核对是已知工作区） ──
    'harness.slashDiscover': ({ backend, cwd }) => wire(harness().slashDiscoverIn(backend, cwd)),
    'harness.slashExpand': ({ backend, cwd, id, args }) =>
      wire(harness().slashExpandIn(backend, cwd, id, args)),
    'harness.gitDiff': ({ cwd }) => wireP(harness().gitDiffIn(cwd)),
    'harness.gitBranch': ({ cwd }) => wireP(harness().gitBranchIn(cwd)),
    'harness.gitSyncStatus': ({ cwd }) => wireP(harness().gitSyncStatusIn(cwd)),
    'harness.gitStage': ({ cwd, paths }) => wireP(harness().gitStageIn(cwd, paths)),
    'harness.gitUnstage': ({ cwd, paths }) => wireP(harness().gitUnstageIn(cwd, paths)),
    'harness.gitCommit': ({ cwd, message, paths }) =>
      wireP(harness().gitCommitIn(cwd, message, paths)),
    'harness.gitCommitUndo': ({ cwd, sha }) => wireP(harness().gitCommitUndoIn(cwd, sha)),
    'harness.gitFetch': ({ cwd }) => wireP(harness().gitFetchIn(cwd)),
    'harness.gitPull': ({ cwd }) => wireP(harness().gitPullIn(cwd)),
    'harness.gitPush': ({ cwd }) => wireP(harness().gitPushIn(cwd)),
    'harness.gitDiscard': ({ cwd, paths }) => wireP(harness().gitDiscardIn(cwd, paths)),
    'harness.gitDiscardUndo': ({ cwd, stashes }) => wireP(harness().gitDiscardUndoIn(cwd, stashes)),
    'harness.gitSuggestMessage': ({ cwd, paths }) =>
      wireP(harness().suggestCommitMessage(cwd, paths ?? undefined)),
    'harness.gitWorktrees': ({ cwd }) => wireP(harness().listWorktrees(cwd)),
    'harness.workspaceList': ({ cwd }) => wireP(harness().workspaceListIn(cwd)),
    'harness.workspaceRead': ({ cwd, path }) => wire(harness().workspaceReadIn(cwd, path)),
    'harness.workspaceWrite': ({ cwd, path, content }) =>
      wire(harness().workspaceWriteIn(cwd, path, content)),
    'harness.workspaceDelete': ({ cwd, path }) => wire(harness().workspaceDeleteIn(cwd, path)),
    'harness.workspaceGitCheckout': ({ cwd, path }) =>
      wireP(harness().workspaceGitCheckoutIn(cwd, path)),

    // ── harness：回答确认（dangerous，契约守卫只放行受信调用方） ──
    'harness.geminiTrustFolder': ({ tabId, messageId, confirmed }) =>
      wireP(harness().trustGeminiFolder(tabId, messageId, { confirmed: confirmed === true })),
    'harness.replyPermission': ({ tabId, requestId, allow, approvePlan }) =>
      harness().answerPermission(tabId, requestId, allow, approvePlan),
    'harness.replyApprovePlan': ({ tabId, requestId, choice }) =>
      harness().answerApprovePlan(tabId, requestId, choice),

    // ── cli：插件注册表 ──
    'cli.registry': () => wire(plugins().snapshot()),
    'cli.pluginAdd': ({ spec }) => wire(plugins().addExternal(spec)),
    'cli.pluginRemove': ({ id }) => plugins().removeExternal(id),
    'cli.pluginTest': ({ spec }) => wireP(plugins().testExternalInTemp(spec)),

    // ── cliAccount：官方账号与登录 ──
    'cliAccount.list': ({ kind }, ctx) =>
      accountCall(ctx, () => wire(accounts().list(kind ? parseAccountKind(kind) : undefined))),
    'cliAccount.refresh': ({ kind }, ctx) =>
      accountCall(ctx, () => wireP(accounts().refreshAll(parseAccountKind(kind)))),
    'cliAccount.setDefault': ({ kind, id }, ctx) =>
      accountCall(ctx, () => wire(accounts().setDefault(parseAccountKind(kind), id))),
    'cliAccount.rename': ({ id, label }, ctx) =>
      accountCall(ctx, () => wire(accounts().rename(id, label))),
    'cliAccount.remove': ({ id, force }, ctx) =>
      accountCall(ctx, () => accounts().remove(id, { force: force === true })),
    'cliAccount.loginStart': ({ kind, accountId }, ctx) =>
      accountCall(ctx, () => wireP(login().start(parseAccountKind(kind), accountId || undefined))),
    'cliAccount.loginInput': ({ id, text }) => login().input(id, text),
    'cliAccount.loginCancel': ({ id }) => login().cancel(id),
    'cliAccount.openUrl': ({ url }) => login().openUrl(url),

    // ── cliUpdate：安装 / 更新 ──
    'cliUpdate.inspect': ({ refresh }) => wireP(updates().inspect(refresh === true)),
    'cliUpdate.preview': ({ kind, scope }) =>
      wireP(updates().previewUpdate(toUpdatable(kind), toScope(scope))),
    'cliUpdate.run': ({ kind, scope }) => wireP(updates().run(toUpdatable(kind), toScope(scope))),
    'cliUpdate.job': ({ kind }) => wire(updates().job(toUpdatable(kind))),
    'cliUpdate.busy': () => updates().busyKinds(),
    'cliUpdate.environment': () => wireP(updates().environment()),
    'cliUpdate.dismiss': ({ kind }) => updates().dismissJob(toUpdatable(kind)),

    // ── delegate：委派 ──
    'delegate.settings': () => wire(delegate().settings()),
    'delegate.setSettings': ({ settings }) => wireP(delegate().setSettings(settings)),
    'delegate.pin': ({ cli, turnId }) => delegate().pin(cli, turnId),
    'delegate.clearPin': ({ turnId }) => {
      delegate().clearPin(turnId);
      return true;
    },
    'delegate.status': ({ taskId }) => wire(delegate().statusOf(taskId)),

    // ── agents：进度监视 ──
    'agents.state': () => wire(agents().state()),
    'agents.scan': () => wireP(agents().scanNow()),
    'agents.setSettings': (patch) =>
      wire(
        agents().setSettings(
          patch as unknown as Parameters<ReturnType<typeof agents>['setSettings']>[0],
        ),
      ),

    // ── history：CLI 会话记录 ──
    'history.list': ({ backend, options }) =>
      wireP(history().list(backend as HistoryBackend, options ?? {})),
    'history.index': ({ backend, options }) =>
      wireP(history().index(backend as HistoryBackend, options ?? {})),
    'history.open': ({ backend, sessionId }) =>
      wireP(history().open(backend as HistoryBackend, sessionId)),
    'history.delete': ({ backend, sessionId }) =>
      wireP(history().remove(backend as HistoryBackend, sessionId)),
  };
}
