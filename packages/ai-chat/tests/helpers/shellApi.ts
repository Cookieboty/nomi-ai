/**
 * D2（应用外壳）视图测试的契约替身：`vi.mock('../src/services/api', () => import('./helpers/shellApi'))`。
 *
 * `api` 是走完整线协议的真客户端（in-process 传输、strict 序列化、入参 schema 校验），
 * D2 的每个过程转发到测试里原有的旧桥假实现（`window.aiIPC.invoke('<旧通道>', …位置参数)`、
 * `window.electronAPI.updates / diagnostics / appIcon`），所以各测试原来的假主进程不用重写；
 * D2 的事件同样从旧桥的 `on` / `onChanged` 转来。返回值与事件不校验（测试只给关心的字段）。
 * 别的域：D3 的过程交给 helpers/codingApi（同样转给旧桥），其余的用 `shellTest.extra` 给。
 */
import { createClient, implement, type Router } from '@nomi-ai/contract';
import { appContract, type ShellEventName, type ShellProcedureName } from '@nomi-ai/contract/app';
import { createInProcessServer, withMissingHandlers } from '@nomi-ai/contract/testing';

import { createCodingApiMock } from './codingApi';

type AnyFn = (...a: unknown[]) => unknown;
type Input = Record<string, unknown>;

interface LegacyBridge {
  invoke?: (ch: string, ...a: unknown[]) => Promise<unknown>;
  on?: (ch: string, fn: (p: unknown) => void) => () => void;
}

const w = () =>
  window as unknown as {
    aiIPC?: LegacyBridge;
    electronAPI?: Record<string, Record<string, AnyFn> | undefined>;
  };

/** 旧桥上的一个调用：`ai:*` 通道（入参 → 位置参数），或 electronAPI 的具名方法 */
type Legacy =
  | { ch: string; args?: (i: Input) => unknown[] }
  | { ns: string; fn: string; args?: (i: Input) => unknown[] };

const ai = (ch: string, args?: (i: Input) => unknown[]): Legacy => ({ ch, args });
const el = (ns: string, fn: string, args?: (i: Input) => unknown[]): Legacy => ({ ns, fn, args });
/** 单个对象参数原样传 */
const whole = (i: Input) => [i];

export const SHELL_LEGACY: Record<ShellProcedureName, Legacy> = {
  'theme.get': ai('ai:theme:get'),
  'theme.set': ai('ai:theme:set', (i) => [i.pref]),
  'locale.get': ai('ai:locale:get'),
  'locale.set': ai('ai:locale:set', (i) => [i.pref]),
  'locale.dict': ai('ai:locale:dict'),
  'startup.get': ai('ai:startup:get'),
  'startup.set': ai('ai:startup:set', whole),
  'onboarding.get': ai('ai:onboarding:get'),
  'onboarding.complete': ai('ai:onboarding:complete', whole),
  'onboarding.reopen': ai('ai:onboarding:reopen'),
  'onboarding.mascot': ai('ai:onboarding:mascot', whole),
  'onboarding.profile': ai('ai:onboarding:profile'),
  'onboarding.setProfile': ai('ai:onboarding:set-profile', whole),
  'providers.presets': ai('ai:providers:presets'),
  'providers.meta': ai('ai:providers:meta'),
  'providers.state': ai('ai:providers:state'),
  'providers.setActive': ai('ai:providers:setActive', (i) => [i.id, i.model]),
  'gateway.state': ai('ai:gateway:state'),
  'gateway.detect': ai('ai:gateway:detect', whole),
  'gateway.retry': ai('ai:gateway:retry'),
  'gateway.upsertProvider': ai('ai:gateway:upsert-provider', whole),
  'gateway.removeProvider': ai('ai:gateway:remove-provider', (i) => [i.id]),
  'gateway.setAssignment': ai('ai:gateway:set-assignment', (i) => [i.client, i.patch]),
  'gateway.setOptions': ai('ai:gateway:set-options', whole),
  'gateway.resetToken': ai('ai:gateway:reset-token', (i) => [i.client]),
  'gateway.clearLearned': ai('ai:gateway:clear-learned', (i) => [i.providerId]),
  'gateway.confirmPrivateHost': ai('ai:gateway:confirm-private-host', (i) => [i.hostPort]),
  'gateway.privacyPreview': ai('ai:gateway:privacy-preview', (i) => [i.text]),
  'gateway.privacyLog': ai('ai:gateway:privacy-log'),
  'gateway.privacyClearLog': ai('ai:gateway:privacy-clear-log'),
  'gateway.privacyAddAllow': ai('ai:gateway:privacy-add-allow', whole),
  'gateway.privacyRemoveAllow': ai('ai:gateway:privacy-remove-allow', (i) => [i.tag]),
  'gateway.privacyAddSecret': ai('ai:gateway:privacy-add-secret', whole),
  'gateway.privacyRemoveSecret': ai('ai:gateway:privacy-remove-secret', (i) => [i.id]),
  'gateway.privacySetAction': ai('ai:gateway:privacy-set-action', (i) => [i.kind, i.action]),
  'gateway.terminalState': ai('ai:gateway:terminal-state'),
  'gateway.terminalSet': ai('ai:gateway:terminal-set', whole),
  'usage.state': ai('ai:usage:state'),
  'usage.setSettings': ai('ai:usage:set-settings', whole),
  'usage.query': ai('ai:usage:query', (i) => [i.range]),
  'usage.details': ai('ai:usage:details', whole),
  'usage.heatmap': ai('ai:usage:heatmap'),
  'usage.csv': ai('ai:usage:csv', whole),
  'usage.clear': ai('ai:usage:clear'),
  'usage.scan': ai('ai:usage:scan'),
  'usage.endpoint': ai('ai:usage:endpoint', (i) => [i.source]),
  'usage.priceSync': ai('ai:usage:price-sync'),
  'usage.quota': ai('ai:usage:quota'),
  'usage.quotaRefresh': ai('ai:usage:quota-refresh', (i) => (i.tool ? [i.tool] : [])),
  'usage.quotaHook': ai('ai:usage:quota-hook'),
  'usage.quotaHookSet': ai('ai:usage:quota-hook-set', (i) => [i.enabled]),
  'quality.query': ai('ai:quality:query', whole),
  'quality.series': ai('ai:quality:series', whole),
  'quality.requests': ai('ai:quality:requests', whole),
  'quality.facets': ai('ai:quality:facets', whole),
  'quality.getSettings': ai('ai:quality:settings-get'),
  'quality.setSettings': ai('ai:quality:settings-set', whole),
  'quality.clear': ai('ai:quality:clear'),
  'quality.exportCsv': ai('ai:quality:export', whole),
  'updates.get': el('updates', 'get'),
  'updates.check': el('updates', 'check'),
  'updates.download': el('updates', 'download'),
  'updates.install': el('updates', 'install'),
  'updates.setAutoCheck': el('updates', 'setAutoCheck', (i) => [i.on]),
  'diagnostics.get': el('diagnostics', 'get'),
  'diagnostics.set': el('diagnostics', 'set', (i) => [i.on]),
  'diagnostics.openFolder': el('diagnostics', 'openFolder'),
  'diagnostics.export': el('diagnostics', 'export'),
  'appIcon.get': el('appIcon', 'get'),
  'appIcon.set': el('appIcon', 'set', (i) => [i.variant]),
};

/** 事件：旧通道（aiIPC.on）或 electronAPI 的订阅方法 */
export const SHELL_LEGACY_EVENTS: Record<ShellEventName, Legacy> = {
  'theme.changed': ai('ai:theme:changed'),
  'locale.changed': ai('ai:locale:changed'),
  'startup.changed': ai('ai:startup:changed'),
  'onboarding.show': ai('ai:onboarding:show'),
  'onboarding.profileChanged': ai('ai:onboarding:profile-changed'),
  'providers.changed': ai('ai:providers:changed'),
  'providers.openPanel': ai('ai:providers:open-panel'),
  'gateway.changed': ai('ai:gateway:changed'),
  'usage.changed': ai('ai:usage:changed'),
  'quality.changed': ai('ai:quality:changed'),
  'updates.changed': el('updates', 'onChanged'),
};

/** 旧桥的 `{ __error }` 信封 → 抛错（与迁移前各客户端模块的处理一致） */
function unwrap(r: unknown): unknown {
  const e = (r as { __error?: { message?: string } } | null)?.__error;
  if (r && typeof r === 'object' && e) throw new Error(e.message ?? 'error');
  return r;
}

/**
 * 事件订阅跟着「当前的」旧桥走：真实应用里一个窗口只有一个契约会话、订阅一次即可，
 * 测试却在每个用例里换一个新的 window.aiIPC / electronAPI——订阅或调用时发现旧桥换了就重新绑定。
 */
interface Sub {
  l: Legacy;
  fn: (p: unknown) => void;
  bound: unknown;
  off: () => void;
}
const subs = new Set<Sub>();
const bridgeOf = (l: Legacy): unknown => ('ch' in l ? w().aiIPC : w().electronAPI?.[l.ns]);
function rebind(): void {
  for (const s of subs) {
    const b = bridgeOf(s.l);
    if (b === s.bound) continue;
    s.off();
    s.bound = b;
    s.off = onLegacy(s.l, s.fn);
  }
}

async function callLegacy(l: Legacy, input: unknown): Promise<unknown> {
  rebind();
  const args = l.args ? l.args((input ?? {}) as Input) : [];
  if ('ch' in l) {
    const b = w().aiIPC;
    if (!b?.invoke) throw new Error('aiIPC unavailable');
    return unwrap(await b.invoke(l.ch, ...args));
  }
  const fn = w().electronAPI?.[l.ns]?.[l.fn];
  if (typeof fn !== 'function') throw new Error(`electronAPI.${l.ns}.${l.fn} unavailable`);
  return fn(...args);
}

function onLegacy(l: Legacy, fn: (p: unknown) => void): () => void {
  if ('ch' in l) return w().aiIPC?.on?.(l.ch, fn) ?? (() => undefined);
  const sub = w().electronAPI?.[l.ns]?.[l.fn];
  return typeof sub === 'function'
    ? ((sub(fn) as () => void) ?? (() => undefined))
    : () => undefined;
}

/**
 * 别的域：D3（编程助手）的过程交给它的替身（helpers/codingApi，按迁移前的通道转给 window.aiIPC）；
 * 其余过程先看 `shellTest.extra` 里有没有测试给的处理函数，没有就失败。
 */
export const shellTest: { extra: Record<string, (input: unknown) => unknown> } = { extra: {} };

const coding = createCodingApiMock({
  invoke: (name, input) => {
    const fn = shellTest.extra[name];
    if (!fn) throw new Error(`no test handler for '${name}'`);
    return fn(input);
  },
});

/** `a.b.c` → api.a.b.c(input) */
function callPath(target: unknown, name: string, input: unknown): unknown {
  let node = target as Record<string, unknown>;
  for (const seg of name.split('.')) node = node[seg] as Record<string, unknown>;
  return (node as unknown as (i: unknown) => unknown)(input);
}

export function createShellTestApi() {
  const handlers: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(appContract.procedures)) {
    if (def.kind === 'stream') continue;
    const l = (SHELL_LEGACY as Record<string, Legacy>)[name];
    handlers[name] = l
      ? (input: unknown) => callLegacy(l, input)
      : (input: unknown) => {
          const fn = shellTest.extra[name];
          return fn ? fn(input) : callPath(coding.api, name, input);
        };
  }
  // 返回值与事件不校验（与 codingApi / knowledgeApi 一致：测试的假主进程只给关心的字段）；
  // 返回值形状由 contract/tests/shell.test.ts 与宿主测试覆盖
  const router = implement(appContract, withMissingHandlers(appContract, handlers as never), {
    validate: { output: false, events: false },
  });
  const server = createInProcessServer();
  server.serve(router as unknown as Router);
  const client = {
    router,
    api: createClient(appContract, server.connect({ surface: 'chat', trusted: true }), {
      handshake: 'off',
      validate: { output: false, events: false },
    }),
  };
  const otherOn = (event: string, fn: (p: unknown) => void): (() => void) => {
    try {
      return (coding.api.on as (e: string, f: (p: unknown) => void) => () => void)(event, fn);
    } catch {
      return (client.api.on as (e: string, f: (p: unknown) => void) => () => void)(event, fn);
    }
  };
  const on = ((event: string, fn: (p: unknown) => void) => {
    const l = (SHELL_LEGACY_EVENTS as Record<string, Legacy>)[event];
    if (!l) return otherOn(event, fn);
    const sub: Sub = {
      l,
      fn: (p) => fn(p === undefined ? null : p),
      bound: undefined,
      off: () => undefined,
    };
    subs.add(sub);
    sub.bound = bridgeOf(l);
    sub.off = onLegacy(l, sub.fn);
    return () => {
      sub.off();
      subs.delete(sub);
    };
  }) as typeof client.api.on;
  // 客户端对象是冻结的：用它做原型，只换掉 on
  const api = Object.create(client.api, { on: { value: on } }) as typeof client.api;
  return { api, router: client.router };
}

const shell = createShellTestApi();

export const api = shell.api;
export const router = shell.router;
/** 有旧桥假实现时视为「有契约传输」，没有时走各客户端模块的本地退路 */
export const hasTransport = (): boolean => Boolean(w().aiIPC || w().electronAPI);
export const installHostBackends = (): void => undefined;
