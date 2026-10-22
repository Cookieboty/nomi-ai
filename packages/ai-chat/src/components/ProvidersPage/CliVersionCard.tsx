/**
 * 端点页的「版本」分组：已装版本 / 最新版本 / 检查更新 / 一键更新；未安装时一键安装。
 * 执行前一定弹出确认框，展示确切命令与前置检查（Node / npm / 写权限）；
 * 没有写权限时不会偷偷提权，只提供「改装到用户目录」或自行在终端处理。
 * 进度与日志来自主进程按行推送的事件；失败原因原样展示。
 */
import { Badge, type BadgeTone, Button, Notice, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  cliUpdateClient,
  type CliInstallInfo,
  type CliInstallPlan,
  type CliInstallScope,
  type CliJob,
  type CliRunResult,
  type CliUpdatableKind,
} from '../../services/cliUpdateClient';

import { CliPlanDialog } from './CliPlanDialog';
import styles from './index.module.css';

const NAME: Record<CliUpdatableKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'dsh',
  grok: 'Grok',
  gemini: 'Gemini',
};

export type VersionState = 'missing' | 'outdated' | 'current' | 'unknown';

/** 纯函数：版本状态（便于测试） */
export function versionState(info: CliInstallInfo | null): VersionState {
  if (!info || !info.path) return info ? 'missing' : 'unknown';
  if (info.updateAvailable) return 'outdated';
  return info.version && info.latest ? 'current' : 'unknown';
}

const cachedInfo = (kind: CliUpdatableKind): CliInstallInfo | null =>
  cliUpdateClient.cached()?.find((r) => r.kind === kind) ?? null;

export const CliVersionCard: React.FC<{ kind: CliUpdatableKind }> = ({ kind }) => {
  // 先用上次的检测结果渲染（切换助手不闪「检测中」），挂载后再在后台校验
  const [info, setInfo] = useState<CliInstallInfo | null>(() => cachedInfo(kind));
  const [checking, setChecking] = useState(false);
  /** 第一次检测是否已结束：之前显示「检测中」，不要冒充「无法检测」 */
  const [loaded, setLoaded] = useState(() => cachedInfo(kind) !== null);
  const [plan, setPlan] = useState<CliInstallPlan | null>(null);
  const [running, setRunning] = useState(false);
  /** 当前正在安装 / 更新的端点（全局同时只有一个）；不是本卡片时也要禁用操作 */
  const [busyKind, setBusyKind] = useState<CliUpdatableKind | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<CliRunResult | null>(null);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLPreElement>(null);
  // kind 切换时渲染期同步清空本卡片的瞬态状态（setState-during-render 模式）
  const [lastKind, setLastKind] = useState(kind);
  if (lastKind !== kind) {
    setLastKind(kind);
    setInfo(cachedInfo(kind));
    setLoaded(cachedInfo(kind) !== null);
    setResult(null);
    setLines([]);
    setRunning(false);
  }

  const load = useCallback(
    async (refreshLatest: boolean) => {
      // 后台静默校验（已有结果）不占用按钮；显式「检查更新」才显示「检查中…」
      const quiet = !refreshLatest && cachedInfo(kind) !== null;
      if (!quiet) setChecking(true);
      setError('');
      try {
        const rows = await cliUpdateClient.inspect(refreshLatest);
        setInfo(Array.isArray(rows) ? (rows.find((r) => r.kind === kind) ?? null) : null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setChecking(false);
        setLoaded(true);
      }
    },
    [kind],
  );

  // 任务状态在主进程：挂载时先取快照（运行中 / 最近一次结果），再订阅增量
  const applyJob = useCallback((j: CliJob | null) => {
    setRunning(j?.status === 'running');
    setLines(j ? j.lines : []);
    setResult(j?.status === 'running' ? null : (j?.result ?? null));
  }, []);

  useEffect(() => {
    // 挂载 / kind 变化时初次拉取 + 订阅主进程事件：属于外部数据同步，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(false);
    let alive = true;
    const off = cliUpdateClient.onEvent((e) => {
      // 任意端点开始 / 结束都更新全局忙碌态（同一时刻只允许一个安装 / 更新）
      if (e.phase === 'start') setBusyKind(e.kind);
      else if (e.phase === 'done' || e.phase === 'error') {
        setBusyKind((b) => (b === e.kind ? null : b));
      }
      if (e.kind !== kind) return;
      if (e.phase === 'start') {
        setRunning(true);
        setResult(null);
        setLines([]);
      } else if (e.phase === 'log') {
        setLines((l) => [...l.slice(-399), e.line]);
      } else {
        // done / error：结果已由主进程保存，取快照并刷新版本（confirm 不再重复刷新）
        void cliUpdateClient.job(kind).then((j) => {
          if (!alive) return;
          applyJob(j);
          void load(true);
        });
      }
    });
    cliUpdateClient
      .job(kind)
      .then((j) => {
        if (alive && j) applyJob(j);
      })
      .catch(() => undefined);
    cliUpdateClient
      .busy()
      .then((b) => {
        if (alive) setBusyKind(b);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [kind, load, applyJob]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const state = versionState(info);
  const name = NAME[kind];
  // 别的端点正在装 / 更新时，本卡片操作一并禁用（全局同时只跑一个任务）
  const otherBusy = Boolean(busyKind && busyKind !== kind);

  const openPlan = async (scope: CliInstallScope = 'global') => {
    setError('');
    setResult(null);
    try {
      setPlan(await cliUpdateClient.preview(kind, scope));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirm = async () => {
    if (!plan || plan.blockers.length) return;
    const scope = plan.scope;
    setPlan(null);
    setRunning(true);
    setResult(null);
    setLines([]);
    try {
      // 任务由主进程持有：这里的 Promise 即使因页面卸载而无人等待，任务也照常运行；
      // 结束时由事件取快照、刷新版本（不在此重复 load(true)，避免一轮多余的 npm view）。
      const r = await cliUpdateClient.run(kind, scope);
      setResult(r);
      setRunning(false);
    } catch (e) {
      setResult({ ok: false, log: e instanceof Error ? e.message : String(e), version: null });
      setRunning(false);
    }
  };

  const dismissResult = () => {
    setResult(null);
    setLines([]);
    void cliUpdateClient.dismiss(kind).catch(() => undefined);
  };

  const statusText =
    state === 'missing'
      ? t('未安装')
      : state === 'outdated'
        ? t('有新版本')
        : state === 'current'
          ? t('已是最新')
          : info
            ? t('已安装')
            : !loaded
              ? t('检测中…')
              : // 主进程没返回这个端点（例如应用还没重启到新版本）：不要冒充「已安装」
                t('无法检测，请重启 Nomi 后再试');
  const statusTone: BadgeTone =
    state === 'current'
      ? 'success'
      : state === 'outdated'
        ? 'warning'
        : state === 'unknown' && loaded && !info
          ? 'danger'
          : 'neutral';

  const actionLabel =
    state === 'missing'
      ? t('一键安装')
      : state === 'outdated'
        ? t('更新到 {0}', info?.latest ?? '')
        : t('重新安装最新版');

  return (
    <SettingsGroup
      title={t('版本')}
      data-testid={`cli-version-card-${kind}`}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={checking || running}
            data-testid={`cli-version-check-${kind}`}
            onClick={() => void load(true)}
          >
            {checking ? t('检查中…') : t('检查更新')}
          </Button>
          {/* 第一次检测完成前不知道该装还是该更新：先不显示主操作 */}
          {loaded && (
            <Button
              size="sm"
              variant={state === 'missing' || state === 'outdated' ? 'primary' : 'secondary'}
              disabled={checking || running || otherBusy || !info}
              title={otherBusy ? t('已有安装 / 更新在进行') : undefined}
              data-testid={`cli-version-action-${kind}`}
              onClick={() => void openPlan()}
            >
              {running ? t('进行中…') : actionLabel}
            </Button>
          )}
        </>
      }
    >
      <SettingRow
        title={t('已装版本')}
        description={
          info?.path ? (
            <span className={styles.path} title={info.path}>
              {info.path}
            </span>
          ) : undefined
        }
      >
        <span className={styles.ver} data-testid={`cli-version-installed-${kind}`}>
          {info?.version ?? '—'}
        </span>
        <Badge tone={statusTone} data-testid={`cli-version-state-${kind}`} data-state={state}>
          {statusText}
        </Badge>
      </SettingRow>
      <SettingRow title={t('最新版本')}>
        <span className={styles.ver} data-testid={`cli-version-latest-${kind}`}>
          {info?.latest ?? '—'}
        </span>
      </SettingRow>

      {info?.runtimeWarning && (
        <Notice tone="warning" data-testid={`cli-runtime-warning-${kind}`}>
          {t(
            'dsh 需要 Node ≥ {0}，当前 PATH 上的 Node 为 {1}；升级 Node 后才能接管 dsh。',
            info.runtimeWarning.required,
            info.runtimeWarning.nodeVersion ?? t('未找到'),
          )}
        </Notice>
      )}
      {error && (
        <Notice tone="danger" data-testid={`cli-version-error-${kind}`}>
          {error}
        </Notice>
      )}
      {(running || lines.length > 0) && (
        <pre
          ref={logRef}
          className={styles.logBox}
          role="log"
          aria-live="polite"
          data-testid={`cli-version-log-${kind}`}
        >
          {lines.join('\n') || t('正在执行…')}
        </pre>
      )}
      {result && (
        <Notice
          tone={result.ok ? 'success' : 'danger'}
          data-testid={`cli-version-result-${kind}`}
          data-ok={result.ok ? '1' : '0'}
        >
          {result.ok
            ? t('{0} 已就绪，版本 {1}。', name, result.version ?? '—')
            : t('{0} 没有安装 / 更新成功：', name)}
          {result.note ? ` ${result.note}` : ''}
          {!result.ok && result.log ? <pre className={styles.logBox}>{result.log}</pre> : null}
          <Button
            size="sm"
            variant="ghost"
            data-testid={`cli-version-dismiss-${kind}`}
            onClick={dismissResult}
          >
            {t('关闭结果')}
          </Button>
        </Notice>
      )}

      <CliPlanDialog
        plan={plan}
        name={name}
        testKind={kind}
        onClose={() => setPlan(null)}
        onConfirm={() => void confirm()}
        onUserScope={() => void openPlan('user')}
      />
    </SettingsGroup>
  );
};
