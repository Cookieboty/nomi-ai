/**
 * D2 的处理函数（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D2。契约声明在 packages/contract/src/app/shell.ts；这里（`appIcon.*` 除外，见下）：
 * - `createShellHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE）。服务直接发布契约事件。
 *
 * 供应商（`providers.*`）的服务是 AI runtime 的 ProviderService：它不认识应用事件总线，所以这里订阅
 * 它的 onChange，经 `deps.events` 发布契约事件 `providers.changed`。
 */

import type { ShellProcedureName } from '@nomi-ai/contract/app';

import type { GatewayService, ProviderInput } from '../gateway/GatewayService';
import type { UsageSettings } from '../usage/UsageService';

import type { ContractDeps, DomainHandlers } from './types';
import { need } from './types';

/** 应用图标（窗口 / 任务栏 / Dock / 托盘图标）是宿主的事：`appIcon.*` 由宿主的片段实现 */
export type ShellHostProcedureName = 'appIcon.get' | 'appIcon.set';

export type ShellHandlers = DomainHandlers<Exclude<ShellProcedureName, ShellHostProcedureName>>;

/** 错误信息里形似 Key 的片段打码，不挂原始错误 */
function redactProviderError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(msg.replace(/\b(sk|key|AIza)[-_A-Za-z0-9]{12,}\b/g, '***').slice(0, 300));
}

/** 供应商状态变化（面板 / 托盘 / 工具栏任一入口）→ 应用事件总线 */
function bindProviderEvents(deps: ContractDeps): void {
  const providers = deps.services.aiRuntime?.providers;
  providers?.onChange(() => deps.events.publish('providers.changed', providers.state()));
}

export function createShellHandlers(deps: ContractDeps): ShellHandlers {
  const s = deps.services;
  const theme = () => need(s.theme, 'theme');
  const locale = () => need(s.locale, 'locale');
  const startup = () => need(s.startup, 'startup');
  const onboarding = () => need(s.onboarding, 'onboarding');
  const providers = () => need(s.aiRuntime, 'aiRuntime').providers;
  const gateway = () => need(s.gateway, 'gateway');
  const terminal = () => need(s.terminal, 'terminal');
  const usage = () => need(s.usage, 'usage');
  const quality = () => need(s.quality, 'quality');
  const updates = () => need(s.updates, 'updates');
  const diagnostics = () => need(s.diagnostics, 'diagnostics');
  /** 服务缺失照常 UNAVAILABLE；服务抛的错按 ProviderIpcServer 的规则打码 */
  const withProviders = <T>(fn: (p: ReturnType<typeof providers>) => T): T => {
    const p = providers();
    try {
      return fn(p);
    } catch (err) {
      throw redactProviderError(err);
    }
  };

  bindProviderEvents(deps);

  return {
    'theme.get': () => theme().get(),
    'theme.set': ({ pref }) => theme().set(pref),

    'locale.get': () => locale().get(),
    'locale.set': ({ pref }) => locale().set(pref),
    'locale.dict': () => locale().dict(),

    'startup.get': () => startup().get(),
    'startup.set': (patch) => startup().set(patch),

    'onboarding.get': () => onboarding().get(),
    'onboarding.complete': ({ skipped }) => onboarding().complete(skipped === true),
    'onboarding.reopen': () => onboarding().reopen(),
    'onboarding.mascot': (cmd) => onboarding().mascot(cmd),
    'onboarding.profile': () => onboarding().profile(),
    'onboarding.setProfile': (profile) => onboarding().setProfile(profile),

    'providers.presets': () => withProviders((p) => [...p.presets()]),
    'providers.meta': () => withProviders((p) => p.meta()),
    'providers.state': () => withProviders((p) => p.state()),
    'providers.setActive': ({ id, model }) =>
      withProviders((p) => p.setActive(id, model ?? undefined)),

    'gateway.state': () => gateway().state(),
    // 网关服务还没起来时当作没配模型（视图按默认预算）
    'gateway.nomiContext': ({ role }) => s.gateway?.nomiContext(role ?? 'chat') ?? null,
    'gateway.detect': (input) => gateway().detect(input),
    'gateway.retry': () => gateway().retry(),
    'gateway.upsertProvider': (input) => gateway().upsertProvider(input as ProviderInput),
    'gateway.removeProvider': ({ id }) => gateway().removeProvider(id),
    'gateway.setAssignment': ({ client, patch }) =>
      gateway().setAssignmentFor(client, patch as Parameters<GatewayService['setAssignment']>[1]),
    'gateway.setOptions': (patch) => gateway().setOptions(patch),
    'gateway.resetToken': ({ client }) => gateway().resetTokenFor(client),
    'gateway.clearLearned': ({ providerId }) => gateway().clearLearned(providerId),
    'gateway.confirmPrivateHost': ({ hostPort }) => gateway().confirmPrivateHost(hostPort),
    'gateway.privacyPreview': ({ text }) => gateway().previewPrivacy(text),
    'gateway.privacyLog': () => gateway().privacyLogEntries(),
    'gateway.privacyClearLog': () => gateway().clearPrivacyLog(),
    'gateway.privacyAddAllow': (input) => gateway().addPrivacyAllow(input),
    'gateway.privacyRemoveAllow': ({ tag }) => gateway().removePrivacyAllow(tag),
    'gateway.privacyAddSecret': (input) => gateway().addPrivacySecret(input),
    'gateway.privacyRemoveSecret': ({ id }) => gateway().removePrivacySecret(id),
    'gateway.privacySetAction': ({ kind, action }) => gateway().setPrivacyAction(kind, action),
    'gateway.terminalState': () => terminal().state(),
    'gateway.terminalSet': (input) => terminal().set(input),

    'usage.state': () => usage().readState(),
    'usage.setSettings': (patch) => usage().setSettings(patch as Partial<UsageSettings>),
    'usage.query': ({ range }) => usage().readQuery(range),
    'usage.details': (q) => usage().readDetails(q),
    'usage.heatmap': () => usage().readHeatmap(),
    'usage.csv': (q) => usage().readCsv(q),
    'usage.clear': () => usage().clearWithState(),
    'usage.scan': () => usage().scanWithState(),
    'usage.endpoint': ({ source }) => usage().readEndpoint(source),
    'usage.priceSync': () => usage().syncPrices(),
    'usage.quota': () => usage().quotaViewed(),
    'usage.quotaRefresh': ({ tool }) => usage().refreshQuota(tool),
    'usage.quotaHook': () => usage().quotaHookStatus(),
    'usage.quotaHookSet': ({ enabled }) => usage().setQuotaHook(enabled),

    'quality.query': (q) => quality().query(q),
    'quality.series': (q) => quality().series(q),
    'quality.requests': (q) => quality().requests(q),
    'quality.facets': (q) => quality().facets(q),
    'quality.getSettings': () => quality().getSettings(),
    'quality.setSettings': (patch) => quality().setSettings(patch),
    'quality.clear': async () => {
      await quality().clear();
      return true;
    },
    'quality.exportCsv': (req) => quality().exportCsv(req),

    'updates.get': () => updates().getState(),
    'updates.check': () => updates().check(),
    'updates.download': () => updates().download(),
    'updates.install': () => updates().install(),
    'updates.setAutoCheck': ({ on }) => {
      updates().setAutoCheck(on);
      return updates().getState();
    },

    'diagnostics.get': () => diagnostics().view(),
    'diagnostics.set': ({ on }) => diagnostics().set(on),
    'diagnostics.openFolder': () => diagnostics().openLogFolder(),
    'diagnostics.export': () => diagnostics().exportBundle(),
  };
}
