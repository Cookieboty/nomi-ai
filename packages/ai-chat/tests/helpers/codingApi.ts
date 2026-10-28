/**
 * 视图测试用的 `services/api` 替身（D3 编程助手）。
 *
 * D3 的客户端模块（harnessClient、cliPluginClient、cliAccountClient、cliUpdateClient、delegateClient、
 * agentsClient、historyClient）已改走契约；很多组件测试仍用旧通道形状的假桥（`window.aiIPC.invoke(ch, …args)`
 * 按通道名分支）。这里把契约调用经完整线协议（in-process 传输、strict 序列化、入参校验）收下，
 * 再按迁移前客户端的参数顺序转给 `window.aiIPC`：测试里的断言（通道名、位置参数）保持不变。
 *
 * - D3 的事件（`api.on('harness.tabsChanged', …)`）转成 `window.aiIPC.on('ai:harness:tabs', …)`；
 * - 其余域的过程交给 `state.invoke(name, input)`（同 knowledgeApi），事件经 `state.router` 推送；
 * - `hasTransport()`：`state.transport` 没设时看测试有没有装 `window.aiIPC`（原客户端的 `available()`）；
 * - 返回值不校验（测试只给关心的字段）；`{ __error }` 信封按原客户端的规则抛出。
 *
 *   const mock = vi.hoisted(() => ({}) as CodingApiMockState);
 *   vi.mock('../src/services/api', async () =>
 *     (await import('./helpers/codingApi')).createCodingApiMock(mock),
 *   );
 */

import { ContractError, createClient, implement, type Router } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createInProcessServer, withMissingHandlers } from '@nomi-ai/contract/testing';

export interface CodingApiMockState {
  /** 其余域的过程名 + 具名入参 */
  invoke?: (name: string, input: unknown) => unknown;
  /** `hasTransport()` 的返回值；不设 = 有没有 `window.aiIPC` */
  transport?: boolean;
  /** createCodingApiMock 填写：推其余域的事件用 */
  router?: Router<AppContract>;
}

type Input = Record<string, unknown>;
type ToLegacy = (i: Input) => [channel: string, ...args: unknown[]];

/** 迁移前客户端的调用形状：过程 → [旧通道, ...位置参数] */
const h = (m: string) => `ai:harness:${m}`;
const PROCEDURES: Record<string, ToLegacy> = {
  'harness.state': () => [h('state')],
  'harness.setBackend': (i) => [h('set-backend'), i.backend],
  'harness.setCwd': (i) => [h('set-cwd'), i.cwd, i.carry === undefined ? {} : { carry: i.carry }],
  'harness.pickCwd': () => [h('pick-cwd')],
  'harness.send': (i) => [h('send'), i.prompt],
  'harness.tabs': () => [h('tabs')],
  'harness.tabCreate': (i) => [h('tab-create'), i],
  'harness.tabSeed': (i) => [h('tab-seed'), i.id, i.messages],
  'harness.tabClose': (i) => [h('tab-close'), i.id],
  'harness.tabRename': (i) => [h('tab-rename'), i.id, i.title],
  'harness.tabActivate': (i) => [h('tab-activate'), i.id],
  'harness.tabBackend': (i) => [h('tab-backend'), i.id, i.backend],
  'harness.tabCwd': (i) => [
    h('tab-cwd'),
    i.id,
    i.cwd,
    i.carry === undefined ? {} : { carry: i.carry },
  ],
  'harness.tabPermissionMode': (i) => [
    h('tab-permission-mode'),
    i.id,
    i.mode,
    {
      ...(i.confirmed === undefined ? {} : { confirmed: i.confirmed }),
      ...(i.expect === undefined ? {} : { expect: i.expect }),
    },
  ],
  'harness.permissionDefaults': (i) => [h('permission-defaults'), i],
  'harness.modelCatalog': (i) => [
    h('model-catalog'),
    i.backend,
    {
      ...(i.refresh === undefined ? {} : { refresh: i.refresh }),
      ...(i.source === undefined ? {} : { source: i.source }),
    },
  ],
  'harness.tabSource': (i) => [h('tab-source'), i.id, i.source, ...(i.model ? [i.model] : [])],
  'harness.tabModel': (i) => [
    h('tab-model'),
    i.id,
    i.model,
    i.expectSource === undefined ? {} : { expectSource: i.expectSource },
  ],
  'harness.tabAccount': (i) => [h('tab-account'), i.id, i.accountId],
  'harness.tabLongContext': (i) => [h('tab-long-context'), i.id, i.on],
  'harness.tabEffort': (i) => [h('tab-effort'), i.id, i.effort],
  'harness.tabPickCwd': (i) => [h('tab-pick-cwd'), i.id],
  'harness.tabCarryClear': (i) => [h('tab-carry-clear'), i.id],
  'harness.tabRewind': (i) => [h('tab-rewind'), i.id, i.messageId],
  'harness.pickDir': (i) => [h('pick-dir'), i.defaultPath],
  'harness.recentCwds': () => [h('recent-cwds')],
  'harness.tabMessages': (i) => [h('tab-messages'), i.id],
  'harness.tabSend': (i) => [h('tab-send'), i.id, i.prompt, i.images],
  'harness.tabCancel': (i) => [h('tab-cancel'), i.id],
  'harness.stopAgent': (i) => [h('stop-agent'), i.id, i.agentId],
  'harness.tabContext': (i) => [h('tab-context'), i.id],
  'harness.slashDiscover': (i) => [h('slash-discover'), i.backend, i.cwd],
  'harness.slashExpand': (i) => [h('slash-expand'), i.backend, i.cwd, i.id, i.args],
  'harness.gitDiff': (i) => [h('git-diff'), i.cwd],
  'harness.gitBranch': (i) => [h('git-branch'), i.cwd],
  'harness.gitSyncStatus': (i) => [h('git-sync-status'), i.cwd],
  'harness.gitStage': (i) => [h('git-stage'), i.cwd, i.paths],
  'harness.gitUnstage': (i) => [h('git-unstage'), i.cwd, i.paths],
  'harness.gitCommit': (i) => [h('git-commit'), i.cwd, i.message, i.paths ?? null],
  'harness.gitCommitUndo': (i) => [h('git-commit-undo'), i.cwd, i.sha],
  'harness.gitFetch': (i) => [h('git-fetch'), i.cwd],
  'harness.gitPull': (i) => [h('git-pull'), i.cwd],
  'harness.gitPush': (i) => [h('git-push'), i.cwd],
  'harness.gitDiscard': (i) => [h('git-discard'), i.cwd, i.paths],
  'harness.gitDiscardUndo': (i) => [h('git-discard-undo'), i.cwd, i.stashes],
  'harness.gitSuggestMessage': (i) => [h('git-suggest-message'), i.cwd, i.paths ?? null],
  'harness.gitWorktrees': (i) => [h('git-worktrees'), i.cwd],
  'harness.workspaceList': (i) => [h('workspace-list'), i.cwd],
  'harness.workspaceRead': (i) => [h('workspace-read'), i.cwd, i.path],
  'harness.workspaceWrite': (i) => [h('workspace-write'), i.cwd, i.path, i.content],
  'harness.workspaceDelete': (i) => [h('workspace-delete'), i.cwd, i.path],
  'harness.workspaceGitCheckout': (i) => [h('workspace-git-checkout'), i.cwd, i.path],
  'harness.geminiTrustFolder': (i) => [
    h('gemini-trust-folder'),
    i.tabId,
    i.messageId,
    { confirmed: i.confirmed },
  ],
  'harness.replyPermission': (i) =>
    i.approvePlan
      ? [h('reply-permission'), i.tabId, i.requestId, i.allow, { approvePlan: i.approvePlan }]
      : [h('reply-permission'), i.tabId, i.requestId, i.allow],
  'harness.replyApprovePlan': (i) => [h('reply-approve-plan'), i.tabId, i.requestId, i.choice],

  'cli.registry': () => ['ai:cli:registry'],
  'cli.pluginAdd': (i) => ['ai:cli:plugin-add', i.spec],
  'cli.pluginRemove': (i) => ['ai:cli:plugin-remove', i.id],
  'cli.pluginTest': (i) => ['ai:cli:plugin-test', i.spec],

  'cliAccount.list': (i) => ['ai:cli-account:list', i.kind],
  'cliAccount.refresh': (i) => ['ai:cli-account:refresh', i.kind],
  'cliAccount.setDefault': (i) => ['ai:cli-account:set-default', i.kind, i.id],
  'cliAccount.rename': (i) => ['ai:cli-account:rename', i.id, i.label],
  'cliAccount.remove': (i) => ['ai:cli-account:remove', i.id, i.force === true],
  'cliAccount.loginStart': (i) => ['ai:cli-account:login-start', i.kind, i.accountId],
  'cliAccount.loginInput': (i) => ['ai:cli-account:login-input', i.id, i.text],
  'cliAccount.loginCancel': (i) => ['ai:cli-account:login-cancel', i.id],
  'cliAccount.openUrl': (i) => ['ai:cli-account:open-url', i.url],

  'cliUpdate.inspect': (i) => ['ai:cli-update:inspect', i.refresh],
  'cliUpdate.preview': (i) => ['ai:cli-update:preview', i.kind, i.scope],
  'cliUpdate.run': (i) => ['ai:cli-update:run', i.kind, i.scope],
  'cliUpdate.job': (i) => ['ai:cli-update:job', i.kind],
  'cliUpdate.busy': () => ['ai:cli-update:busy'],
  'cliUpdate.dismiss': (i) => ['ai:cli-update:dismiss', i.kind],

  'delegate.settings': () => ['ai:delegate:settings'],
  'delegate.setSettings': (i) => ['ai:delegate:set-settings', i.settings],
  'delegate.pin': (i) => ['ai:delegate:pin', i.cli, i.turnId],
  'delegate.clearPin': (i) => ['ai:delegate:clear-pin', i.turnId],
  'delegate.status': (i) => ['ai:delegate:status', i.taskId],

  'agents.state': () => ['ai:agents:state'],
  'agents.scan': () => ['ai:agents:scan'],
  'agents.setSettings': (i) => ['ai:agents:set-settings', i],

  'history.list': (i) => ['ai:history:list', i.backend, i.options ?? {}],
  'history.index': (i) => ['ai:history:index', i.backend, i.options ?? {}],
  'history.open': (i) => ['ai:history:open', i.backend, i.sessionId],
  'history.delete': (i) => ['ai:history:delete', i.backend, i.sessionId],
};

/** 契约事件 → 旧通道 */
const EVENTS: Record<string, string> = {
  'harness.changed': 'ai:harness:changed',
  'harness.tabsChanged': 'ai:harness:tabs',
  'harness.events': 'ai:harness:events',
  'harness.tabMessage': 'ai:harness:tab-message',
  'cli.registryChanged': 'ai:cli:registry-changed',
  'cliAccount.changed': 'ai:cli-account:changed',
  'cliAccount.login': 'ai:cli-account:login',
  'cliUpdate.event': 'ai:cli-update:event',
  'delegate.completed': 'ai:delegate:completed',
  'agents.changed': 'ai:agents:changed',
};

/** 账号错误的 kebab code → 契约码（cliAccountClient 再换回去） */
const ACCOUNT_CODES: Record<string, string> = {
  'not-found': 'ACCOUNT_NOT_FOUND',
  'in-use': 'ACCOUNT_IN_USE',
  local: 'ACCOUNT_LOCAL',
  unsupported: 'ACCOUNT_UNSUPPORTED',
  'unknown-live': 'ACCOUNT_UNKNOWN_LIVE',
};

interface LegacyBridge {
  invoke: (channel: string, ...args: unknown[]) => unknown;
  on?: (channel: string, fn: (payload: unknown) => void) => (() => void) | void;
}

function legacy(): LegacyBridge | undefined {
  const b = (globalThis as { window?: { aiIPC?: LegacyBridge } }).window?.aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
}

async function forward(name: string, input: unknown): Promise<unknown> {
  const b = legacy();
  if (!b) throw new Error(`no window.aiIPC for '${name}'`);
  const [channel, ...args] = PROCEDURES[name]!((input ?? {}) as Input);
  const r = (await b.invoke(channel, ...args)) as { __error?: { message: string; code?: string } };
  if (r && typeof r === 'object' && '__error' in r && r.__error) {
    const code = r.__error.code ? ACCOUNT_CODES[r.__error.code] : undefined;
    if (code) throw new ContractError(code, r.__error.message);
    throw new Error(r.__error.message);
  }
  return r;
}

export function createCodingApiMock(state: CodingApiMockState) {
  const handlers: Record<string, (input: unknown) => unknown> = {};
  for (const [name, def] of Object.entries(appContract.procedures)) {
    if (def.kind === 'stream') continue;
    handlers[name] = PROCEDURES[name]
      ? (input) => forward(name, input)
      : (input) => {
          if (!state.invoke) throw new Error(`no test handler for '${name}'`);
          return state.invoke(name, input);
        };
  }
  // 与 createTestClient 相同的组装（strict 序列化、入参校验），只是两端都不校验返回值
  const router = implement(appContract, withMissingHandlers(appContract, handlers as never), {
    validate: { output: false },
  });
  state.router = router;
  const server = createInProcessServer();
  server.serve(router as never);
  const client = createClient(appContract, server.connect(), {
    handshake: 'off',
    validate: { output: false, events: false },
  });
  const on = (event: string, fn: (payload: unknown) => void): (() => void) => {
    const channel = EVENTS[event];
    if (!channel)
      return (client.on as (e: string, f: (p: unknown) => void) => () => void)(event, fn);
    const off = legacy()?.on?.(channel, fn);
    return typeof off === 'function' ? off : () => undefined;
  };
  // 客户端是冻结的普通对象：拷一份，只换掉 on
  const api = Object.freeze({ ...client, on }) as typeof client;
  return {
    api,
    hasTransport: () => state.transport ?? !!legacy(),
    installHostBackends: () => undefined,
  };
}
