import { t } from '@nomi-ai/ui';

import type { CliAccount } from '../services/cliAccountClient';
import {
  useCliLauncher,
  useCliLauncherReady,
  useHasLocalLogin,
} from '../services/cliLauncherClient';
import { codingModelChoices, isCliKind, tabSourceOf, thirdPartyRefOf } from '../services/cliSource';
import { gatewayClientAvailable, type GatewayState } from '../services/gatewayClient';
import type { HarnessTabMeta } from '../services/harnessClient';
import { useGatewayState } from '../services/nomiModel';
import { hasOfficialAccount, localOnly, thirdPartyOnly } from '../utils/cliCaps';
import { ENDPOINT_NAME } from '../utils/endpointBadge';

import { useCliAccounts } from './useCliAccounts';

export type CliTabReadinessStatus = 'ready' | 'loading' | 'needs-model' | 'needs-setup';

export interface CliTabReadiness {
  status: CliTabReadinessStatus;
  reason: string | null;
  thirdPartyOnly: boolean;
}

export interface CliTabReadinessInput {
  tab: HarnessTabMeta | null | undefined;
  gateway: GatewayState | null;
  accounts: readonly CliAccount[];
  accountsReady: boolean;
  hasLocalLogin: boolean;
  launcherAccountSource?: 'local' | 'nomi';
  launcherReady?: boolean;
}

/**
 * 判断 CLI 标签发送前是否已具备可用凭证 / 模型（与后端 tabPreflightError 对齐）：
 * - ready：来源凭证与目标模型均已就绪
 * - loading：网关 / 账号 / 启动配置尚未加载完
 * - needs-model：当前来源不可用但仍有可切换模型或未选第三方模型
 * - needs-setup：当前助手既无可用账号登录，也无任何可用第三方模型
 */
export function cliTabReadiness({
  tab,
  gateway,
  accounts,
  accountsReady,
  hasLocalLogin,
  launcherAccountSource,
  launcherReady = true,
}: CliTabReadinessInput): CliTabReadiness {
  if (!tab || !isCliKind(tab.backend)) {
    return { status: 'ready', reason: null, thirdPartyOnly: false };
  }
  if (localOnly(tab.backend)) {
    return { status: 'ready', reason: null, thirdPartyOnly: false };
  }
  const tpOnly = thirdPartyOnly(tab.backend);
  const backendName = t(ENDPOINT_NAME[tab.backend]);
  if (gateway === null || (!tpOnly && (!accountsReady || !launcherReady))) {
    return { status: 'loading', reason: null, thirdPartyOnly: tpOnly };
  }

  const choices = codingModelChoices(gateway);
  const hasThirdParty = choices.length > 0;
  const hasSignedInOfficial = accounts.some((a) => a.loggedIn);
  const launcherManages = launcherAccountSource === 'local';
  const source = tabSourceOf(tab);

  switch (source) {
    case 'thirdParty': {
      const ref = thirdPartyRefOf(tab, tab.backend, gateway);
      if (ref && choices.some((m) => m.ref === ref)) {
        return { status: 'ready', reason: null, thirdPartyOnly: tpOnly };
      }
      if (hasThirdParty || (!tpOnly && (hasSignedInOfficial || hasLocalLogin))) {
        return {
          status: 'needs-model',
          reason: t('electron.common.this-tab-has-no-third-party-model-yet'),
          thirdPartyOnly: tpOnly,
        };
      }
      return {
        status: 'needs-setup',
        reason: t(
          tpOnly ? 'ui.models.cli-welcome-setup-desc-tp-only' : 'ui.models.cli-welcome-setup-desc',
          backendName,
        ),
        thirdPartyOnly: tpOnly,
      };
    }
    case 'local': {
      if (tpOnly) {
        return hasThirdParty
          ? {
              status: 'needs-model',
              reason: t('electron.common.only-third-party-models', backendName),
              thirdPartyOnly: true,
            }
          : {
              status: 'needs-setup',
              reason: t('ui.models.cli-welcome-setup-desc-tp-only', backendName),
              thirdPartyOnly: true,
            };
      }
      if (hasLocalLogin) {
        return { status: 'ready', reason: null, thirdPartyOnly: false };
      }
      if (hasSignedInOfficial || hasThirdParty) {
        return {
          status: 'needs-model',
          reason: t('electron.common.no-local-login-detected-for', backendName),
          thirdPartyOnly: false,
        };
      }
      return {
        status: 'needs-setup',
        reason: t('ui.models.cli-welcome-setup-desc', backendName),
        thirdPartyOnly: false,
      };
    }
    case 'official': {
      if (tpOnly) {
        return hasThirdParty
          ? {
              status: 'needs-model',
              reason: t('electron.common.only-third-party-models', backendName),
              thirdPartyOnly: true,
            }
          : {
              status: 'needs-setup',
              reason: t('ui.models.cli-welcome-setup-desc-tp-only', backendName),
              thirdPartyOnly: true,
            };
      }
      if (launcherManages || hasSignedInOfficial) {
        return { status: 'ready', reason: null, thirdPartyOnly: false };
      }
      if (hasLocalLogin || hasThirdParty) {
        return {
          status: 'needs-model',
          reason: t('electron.common.no-official-account-signed-in-for', backendName),
          thirdPartyOnly: false,
        };
      }
      return {
        status: 'needs-setup',
        reason: t('ui.models.cli-welcome-setup-desc', backendName),
        thirdPartyOnly: false,
      };
    }
  }
}

export function useCliTabReadiness(tab: HarnessTabMeta | null | undefined): CliTabReadiness {
  const gwAvailable = gatewayClientAvailable();
  const activeKind = gwAvailable && tab && isCliKind(tab.backend) ? tab.backend : null;
  const gateway = useGatewayState();
  const launcher = useCliLauncher(activeKind);
  const hasLocalLogin = useHasLocalLogin(activeKind);
  const launcherReady = useCliLauncherReady();
  const { accounts, ready: accountsReady } = useCliAccounts(
    activeKind && hasOfficialAccount(activeKind) ? activeKind : null,
  );

  if (!activeKind) {
    return {
      status: 'ready',
      reason: null,
      thirdPartyOnly: !!tab && thirdPartyOnly(tab.backend),
    };
  }

  return cliTabReadiness({
    tab,
    gateway,
    accounts,
    accountsReady,
    hasLocalLogin,
    launcherAccountSource: launcher.accountSource,
    launcherReady,
  });
}
