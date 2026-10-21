/**
 * 「模型」页 CLI 行的安装状态与「安装」（§4.1）：复用「编程助手」页版本卡片的 cliUpdateClient
 * （inspect 判断是否安装、preview 给出确切命令、run 执行）和同一个确认框 CliPlanDialog，不另写安装命令。
 */
import { ModalHostContext, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import type { CliKind } from '../../services/cliSource';
import {
  cliUpdateClient,
  type CliInstallInfo,
  type CliInstallPlan,
  type CliInstallScope,
  type CliUpdatableKind,
} from '../../services/cliUpdateClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { CliPlanDialog } from '../ProvidersPage/CliPlanDialog';

export interface CliInstallState {
  /** 主进程明确报告没装（没有返回这个端点时不算没装） */
  missing: (kind: CliKind) => boolean;
  /** 正在安装 / 更新的端点（同一时刻只有一个） */
  busy: CliUpdatableKind | null;
  install: (kind: CliKind) => void;
  dialog: React.ReactNode;
}

export function useCliInstall(onError: (message: string) => void): CliInstallState {
  const [infos, setInfos] = useState<CliInstallInfo[]>([]);
  const [plan, setPlan] = useState<CliInstallPlan | null>(null);
  const [busy, setBusy] = useState<CliUpdatableKind | null>(null);

  const load = useCallback(() => {
    if (!cliUpdateClient.available()) return;
    cliUpdateClient
      .inspect(false)
      .then((rows) => setInfos(Array.isArray(rows) ? rows : []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!cliUpdateClient.available()) return;
    load();
    cliUpdateClient
      .busy()
      .then((b) => setBusy(b))
      .catch(() => undefined);
    return cliUpdateClient.onEvent((e) => {
      if (e.phase === 'start') setBusy(e.kind);
      else if (e.phase === 'done' || e.phase === 'error') {
        setBusy((b) => (b === e.kind ? null : b));
        load();
      }
    });
  }, [load]);

  const openPlan = (kind: CliUpdatableKind, scope: CliInstallScope = 'global') =>
    cliUpdateClient
      .preview(kind, scope)
      .then(setPlan)
      .catch((e: Error) => onError(e.message));

  const confirm = () => {
    if (!plan || plan.blockers.length) return;
    const { kind, scope } = plan;
    setPlan(null);
    setBusy(kind);
    cliUpdateClient
      .run(kind, scope)
      .then((r) => {
        if (!r.ok) onError(t('{0} 没有安装 / 更新成功：', ENDPOINT_NAME[kind]) + (r.note || r.log));
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => {
        setBusy((b) => (b === kind ? null : b));
        load();
      });
  };

  const name = plan ? ENDPOINT_NAME[plan.kind] : '';
  return {
    missing: (kind) => {
      const info = infos.find((i) => (i.kind as string) === kind);
      return Boolean(info && !info.path);
    },
    busy,
    install: (kind) => void openPlan(kind),
    dialog: (
      // 设置页以内嵌方式渲染面板；确认框要浮在页面上方
      <ModalHostContext.Provider value={null}>
        <CliPlanDialog
          plan={plan}
          name={name}
          testKind={plan?.kind ?? 'none'}
          onClose={() => setPlan(null)}
          onConfirm={confirm}
          onUserScope={() => plan && void openPlan(plan.kind, 'user')}
        />
      </ModalHostContext.Provider>
    ),
  };
}
