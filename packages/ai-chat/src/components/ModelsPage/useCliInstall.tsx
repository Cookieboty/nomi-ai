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
  /** 本机是否装了任一编程助手（还没查到结果时为 null） */
  anyInstalled: boolean | null;
  /** 该端点正在安装 / 更新（不同端点可以同时进行） */
  busy: (kind: CliKind) => boolean;
  install: (kind: CliKind) => void;
  dialog: React.ReactNode;
}

export function useCliInstall(onError: (message: string) => void): CliInstallState {
  const [infos, setInfos] = useState<CliInstallInfo[] | null>(null);
  const [plan, setPlan] = useState<CliInstallPlan | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<CliUpdatableKind>>(() => new Set());
  const mark = useCallback((kind: CliUpdatableKind, on: boolean) => {
    setBusy((cur) => {
      if (cur.has(kind) === on) return cur;
      const next = new Set(cur);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }, []);

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
      .then((kinds) => setBusy(new Set(kinds)))
      .catch(() => undefined);
    return cliUpdateClient.onEvent((e) => {
      if (e.phase === 'start') mark(e.kind, true);
      else if (e.phase === 'done' || e.phase === 'error') {
        mark(e.kind, false);
        load();
      }
    });
  }, [load, mark]);

  const openPlan = (kind: CliUpdatableKind, scope: CliInstallScope = 'global') =>
    cliUpdateClient
      .preview(kind, scope)
      .then(setPlan)
      .catch((e: Error) => onError(e.message));

  const confirm = () => {
    if (!plan || plan.blockers.length) return;
    const { kind, scope } = plan;
    setPlan(null);
    mark(kind, true);
    cliUpdateClient
      .run(kind, scope)
      .then((r) => {
        if (!r.ok)
          onError(
            t('ui.cli-monitor.could-not-be-installed-updated', ENDPOINT_NAME[kind]) +
              (r.note || r.log),
          );
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => {
        mark(kind, false);
        load();
      });
  };

  const name = plan ? ENDPOINT_NAME[plan.kind] : '';
  return {
    missing: (kind) => {
      const info = infos?.find((i) => (i.kind as string) === kind);
      return Boolean(info && !info.path);
    },
    anyInstalled: infos && infos.some((i) => !!i.path),
    busy: (kind) => busy.has(kind as CliUpdatableKind),
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
