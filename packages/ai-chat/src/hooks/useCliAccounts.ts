/**
 * 编程助手官方账号列表（主进程 AccountService，见 services/cliAccountClient）。
 * 「模型」页新标签默认用、侧栏信息卡共用：按后端筛选当前后端的账号，账号增删 / 登录态变化时自动刷新。
 * 加载失败时返回空列表并带上 error，避免下拉框空白且无反馈。
 */
import { createLogger } from '@nomi-ai/ui';
import { useEffect, useState } from 'react';

import { cliAccountClient, type AccountKind, type CliAccount } from '../services/cliAccountClient';
import { hasOfficialAccount } from '../utils/cliCaps';

const log = createLogger('cli-accounts');

export interface CliAccountsState {
  accounts: CliAccount[];
  /** 最近一次 list 失败的原因；成功后清空 */
  error: string | null;
}

export function useCliAccounts(kind: string | null | undefined): CliAccountsState {
  const accountKind: AccountKind | null = hasOfficialAccount(kind) ? kind : null;
  const [loaded, setLoaded] = useState<{
    kind: AccountKind;
    list: CliAccount[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!accountKind) return;
    let alive = true;
    const load = () => {
      void cliAccountClient
        .list(accountKind)
        .then((list) => {
          if (alive) setLoaded({ kind: accountKind, list, error: null });
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          log.warn('failed to list official accounts', { kind: accountKind, message });
          if (alive) setLoaded({ kind: accountKind, list: [], error: message });
        });
    };
    load();
    const off = cliAccountClient.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [accountKind]);
  if (!accountKind) return { accounts: [], error: null };
  if (loaded?.kind !== accountKind) return { accounts: [], error: null };
  return { accounts: loaded.list, error: loaded.error };
}
