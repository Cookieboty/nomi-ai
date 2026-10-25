/**
 * 编程助手官方账号列表（主进程 AccountService，见 services/cliAccountClient）。
 * 「模型」页新标签默认用、侧栏信息卡共用：按后端筛选当前后端的账号，账号增删 / 登录态变化时自动刷新。
 */
import { useEffect, useState } from 'react';

import { cliAccountClient, type AccountKind, type CliAccount } from '../services/cliAccountClient';
import { hasOfficialAccount } from '../utils/cliCaps';

export function useCliAccounts(kind: string | null | undefined): CliAccount[] {
  const accountKind: AccountKind | null = hasOfficialAccount(kind) ? kind : null;
  const [loaded, setLoaded] = useState<{ kind: AccountKind; list: CliAccount[] } | null>(null);
  useEffect(() => {
    if (!accountKind) return;
    let alive = true;
    const load = () => {
      void cliAccountClient
        .list(accountKind)
        .then((list) => {
          if (alive) setLoaded({ kind: accountKind, list });
        })
        .catch(() => undefined);
    };
    load();
    const off = cliAccountClient.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [accountKind]);
  if (!accountKind) return [];
  return loaded?.kind === accountKind ? loaded.list : [];
}
