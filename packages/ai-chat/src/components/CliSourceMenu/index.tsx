/**
 * CLI 标签的来源菜单（docs/design/unified-gateway.md §4.3）：对话区右上角，与 Nomi 的模型切换同一位置。
 *
 * - 官方账号：这个 CLI 当前的全局官方账号（选别的账号 = 沿用现有行为，全局切换账号）；选中即让标签改用官方；
 * - 第三方：网关里能给编程助手用的模型，选中即让标签改用第三方的这个模型（tab-source）；
 * - 打开模型设置。
 * 切换规则由主进程执行；第三方 → 官方且已有对话时这里先确认（会带上下文新开会话，原会话保留）。
 * 只显示当前后端自己的官方账号，切到别的后端时不会残留上一个后端的账号（#69）。
 */
import { Select, t, type SelectOption } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import {
  cliAccountClient,
  type AccountKind,
  type CliAccount,
} from '../../services/cliAccountClient';
import {
  codingModelChoices,
  refSlashLabel,
  switchTabSource,
  tabSourceOf,
  thirdPartyRefOf,
  type CliKind,
} from '../../services/cliSource';
import { gatewayClientAvailable } from '../../services/gatewayClient';
import type { HarnessTabMeta } from '../../services/harnessClient';
import { useGatewayState } from '../../services/nomiModel';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';

const OFFICIAL = 'official';
const ACCOUNT_PREFIX = 'account:';
const OPEN_MODELS = '__open-models';

const accountName = (a: CliAccount) => a.identity?.email ?? a.label;

export const CliSourceMenu: React.FC<{
  backend: CliKind;
  /** 当前 CLI 标签；还没拿到标签信息时为 null（只能看，不能切） */
  tab: HarnessTabMeta | null;
  /** 标签里已有对话（第三方 → 官方时要确认） */
  hasMessages: boolean;
  onOpenModels: () => void;
  className?: string;
}> = ({ backend, tab, hasMessages, onOpenModels, className }) => {
  const gateway = useGatewayState();
  const [accounts, setAccounts] = useState<CliAccount[]>([]);
  const [err, setErr] = useState('');
  // dsh 没有官方登录
  const accountKind: AccountKind | null = backend === 'dsh' ? null : backend;

  useEffect(() => {
    if (!accountKind) return;
    let alive = true;
    const load = () =>
      void cliAccountClient
        .list(accountKind)
        .then((l) => alive && setAccounts(l))
        .catch(() => alive && setAccounts([]));
    load();
    const off = cliAccountClient.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [accountKind]);

  const source = tabSourceOf(tab);
  const own = useMemo(
    () => (accountKind ? accounts.filter((a) => a.kind === accountKind) : []),
    [accounts, accountKind],
  );
  const active = own.find((a) => a.active);
  const models = useMemo(
    () => (gatewayClientAvailable() ? codingModelChoices(gateway) : []),
    [gateway],
  );
  const ref = source === 'thirdParty' ? thirdPartyRefOf(tab, backend, gateway) : null;

  const officialLabel = !accountKind
    ? t('dsh 自带配置')
    : active
      ? t('官方 · {0}', accountName(active))
      : t('官方');

  const options = useMemo<SelectOption[]>(() => {
    const officialGroup = t('官方账号');
    const thirdGroup = t('第三方');
    const out: SelectOption[] = [
      {
        value: OFFICIAL,
        group: officialGroup,
        label: officialLabel,
        description: active?.identity?.plan,
      },
      ...own
        .filter((a) => !a.active)
        .map((a) => ({
          value: `${ACCOUNT_PREFIX}${a.id}`,
          group: officialGroup,
          label: t('官方 · {0}', accountName(a)),
          description: a.identity?.plan,
        })),
      ...models.map((m) => ({
        value: m.ref,
        group: thirdGroup,
        label: m.label,
        disabled: !tab,
        searchText: `${m.ref} ${m.label}`,
      })),
    ];
    // 标签用的模型已不在网关的可用列表里（供应商被删 / 模型被停用）：仍显示出来
    if (ref && !models.some((m) => m.ref === ref))
      out.push({ value: ref, group: thirdGroup, label: refSlashLabel(gateway, ref) });
    out.push({ value: OPEN_MODELS, group: t('设置'), label: t('打开模型设置') });
    return out;
  }, [officialLabel, active, own, models, ref, gateway, tab]);

  const pick = async (value: string) => {
    setErr('');
    if (value === OPEN_MODELS) {
      onOpenModels();
      return;
    }
    try {
      if (value === OFFICIAL || value.startsWith(ACCOUNT_PREFIX)) {
        const acc = value.startsWith(ACCOUNT_PREFIX)
          ? own.find((a) => a.id === value.slice(ACCOUNT_PREFIX.length))
          : undefined;
        // 过时的选项（别的后端的账号）不切换
        if (value !== OFFICIAL && (!acc || !accountKind)) return;
        if (tab && source !== 'official') {
          const r = await switchTabSource(tab, 'official', { hasMessages });
          if (!r) return;
        }
        // 选了别的官方账号：沿用现有行为，全局切换
        if (acc && accountKind) await cliAccountClient.activate(acc.id, accountKind);
        return;
      }
      if (!tab || (source === 'thirdParty' && value === ref)) return;
      await switchTabSource(tab, 'thirdParty', { model: value, hasMessages });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const value = source === 'thirdParty' ? (ref ?? '') : OFFICIAL;
  const name = ENDPOINT_NAME[backend];
  return (
    <span
      className={[styles.menu, className].filter(Boolean).join(' ')}
      data-testid="cli-source-menu"
      data-backend={backend}
      data-source={source}
    >
      <Select
        size="sm"
        variant="ghost"
        className={styles.select}
        data-testid="cli-source-switch"
        aria-label={t('{0} 标签的来源', name)}
        title={
          err ||
          (source === 'thirdParty'
            ? t('这个标签经 Nomi 网关用第三方模型，只影响这个标签')
            : t('这个标签用 {0} 的官方账号（全局账号）', name))
        }
        value={value}
        placeholder={t('第三方 · 未设置模型')}
        onChange={(e) => void pick(e.target.value)}
        menuMinWidth={280}
        options={options}
      />
      {err && (
        <span role="alert" data-testid="cli-source-err" className={styles.err}>
          {err}
        </span>
      )}
    </span>
  );
};
