/**
 * 「编程助手」页：逐个配置各编程助手（CLI），分段标签「助手 / 监视与会话」。
 * Nomi 自己的设置（权限、委派、工具权限）在设置 →「Nomi」。
 * - 助手：左右两栏。左栏固定的列表：五个内置助手（带安装状态）、外部 CLI、通用；
 *   右栏只显示选中那一项：
 *   - 内置助手：标题行（名称、路径、版本、检查更新 / 安装）→ 官方账号 → 第三方模型入口
 *     （第三方供应商与模型分配都在设置 →「模型」，统一网关）；
 *   - 外部 CLI：用户添加的说 ACP 的编程助手；
 *   - 通用：运行环境（Node.js / npm）与「全部自动」权限。运行环境有问题时左栏「通用」亮警示点，
 *     助手详情顶部也提示一行。
 *   窄窗口时左栏收成顶部一排（容器查询）。
 * - 监视与会话：本机编程助手进度监视设置 + 活跃会话列表。
 * 切换只是换一个视图，不会改任何配置。
 */
import { Button, Notice, t, Tabs } from '@nomi-ai/ui';
import { Settings2, SquareTerminal } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { useProviderEndpoint } from '../../hooks/useProviderEndpoint';
import { isCliKind, type CliKind } from '../../services/cliSource';
import { cliUpdateClient, type CliInstallInfo } from '../../services/cliUpdateClient';
import { harnessClient } from '../../services/harnessClient';
import { CONVERSATION_BACKENDS } from '../../types/chat';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { CodingMonitor } from '../CodingMonitor';
import { EndpointIcon } from '../EndpointIcon';

import { AutoApproveSetting } from './AutoApproveSetting';
import { CliEndpointSection } from './CliEndpointSection';
import { ExternalClis } from './ExternalClis';
import styles from './index.module.css';
import { envHasProblem, RuntimeEnvironment, useCliEnvironment } from './RuntimeEnvironment';

/** 左栏助手的顺序：与对话区端点顺序一致，去掉 Nomi（Nomi 的模型在「模型」页） */
const CLIS = CONVERSATION_BACKENDS.filter((b): b is CliKind => b !== 'nomi');

/** 左栏的一项：内置助手、外部 CLI、通用 */
type Item = CliKind | 'external' | 'general';
const ITEMS: Item[] = [...CLIS, 'external', 'general'];
const isItem = (v: string): v is Item => v === 'external' || v === 'general' || isCliKind(v);

/** plain：只是一行说明，不带状态点 */
type Tone = 'ok' | 'warn' | 'off' | 'plain';

export const ProvidersPage: React.FC<{
  onOpenedTab?: () => void;
  onOpenNotify?: () => void;
  onOpenModels?: () => void;
}> = ({ onOpenedTab, onOpenNotify, onOpenModels }) => {
  const [ep, setEp] = useProviderEndpoint();
  const cliOk = harnessClient.available();
  // 「监视与会话」时记住上次看的那一项；旧的「nomi」等选中值落到第一个助手
  const [lastItem, setLastItem] = useState<Item>(() => (isItem(ep) ? ep : CLIS[0]!));
  const item: Item = isItem(ep) ? ep : lastItem;
  const view = ep === 'monitor' ? ep : 'assistants';
  const pick = (k: Item) => {
    setLastItem(k);
    setEp(k);
  };
  const runtime = useCliEnvironment();
  const envBad = envHasProblem(runtime.env);

  // 左栏的安装状态：复用「版本」分组的 cliUpdateClient.inspect（只读，不触发联网检查）
  const [infos, setInfos] = useState<CliInstallInfo[] | null>(() => cliUpdateClient.cached());
  useEffect(() => {
    if (!cliUpdateClient.available()) return;
    let alive = true;
    const refresh = () =>
      cliUpdateClient
        .inspect(false)
        .then((rows) => alive && setInfos(Array.isArray(rows) ? rows : []))
        .catch(() => undefined);
    void refresh();
    // 装 / 更新结束后主进程会重新探测：选择条上的状态跟着刷新
    const off = cliUpdateClient.onEvent((e) => {
      if (e.phase === 'done' || e.phase === 'error') void refresh();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  const statusOf = (b: CliKind): { label: string; tone: Tone } | null => {
    const info = infos?.find((x) => x.kind === b);
    if (!info) return null; // 主进程没报告这个端点：不猜
    if (!info.path) return { label: t('ui.mascot-theme.not-installed'), tone: 'off' };
    if (info.updateAvailable) return { label: t('ui.cli-monitor.update-available'), tone: 'warn' };
    return {
      label: info.version
        ? t('ui.chat-settings.installed', info.version)
        : t('ui.knowledge-local.installed'),
      tone: 'ok',
    };
  };

  // 竖排列表：上下键切换（窄窗口横排时左右键也行），Home / End 到头尾
  const onKey = (e: React.KeyboardEvent) => {
    const i = ITEMS.indexOf(item);
    const n = ITEMS.length;
    const next =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? (i + 1) % n
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? (i + n - 1) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    pick(ITEMS[next]!);
    // 焦点跟着选中项走（roving tabindex）
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-testid="providers-endpoint-${ITEMS[next]}"]`)
        ?.focus(),
    );
  };

  const navButton = (
    k: Item,
    icon: React.ReactNode,
    name: string,
    st: { label: string; tone: Tone } | null,
  ) => {
    const on = item === k;
    return (
      <button
        key={k}
        type="button"
        role="tab"
        id={`providers-tab-${k}`}
        aria-selected={on}
        aria-controls="providers-detail"
        tabIndex={on ? 0 : -1}
        className={`${styles.pick} ${on ? styles.pickOn : ''}`}
        data-testid={`providers-endpoint-${k}`}
        onClick={() => pick(k)}
      >
        {icon}
        <span className={styles.pickText}>
          <span className={styles.pickName}>{name}</span>
          {st && (
            <span
              className={styles.pickStatus}
              data-tone={st.tone}
              data-testid={`providers-endpoint-status-${k}`}
            >
              {st.label}
            </span>
          )}
        </span>
      </button>
    );
  };

  const detail = (() => {
    if (item === 'general')
      return (
        <div className={styles.section} data-testid="providers-section-general">
          <RuntimeEnvironment {...runtime} />
          <AutoApproveSetting />
        </div>
      );
    if (!cliOk)
      return (
        <p className={styles.sub}>
          {t('ui.mascot-theme.coding-agent-harness-requires-the-desktop-app')}
        </p>
      );
    if (item === 'external') return <ExternalClis onOpenedTab={onOpenedTab} />;
    return (
      <>
        {envBad && (
          <Notice tone="warning" data-testid="providers-runtime-warning">
            {t('ui.providers-schedule.runtime-problem-notice')}{' '}
            <Button size="sm" variant="ghost" onClick={() => pick('general')}>
              {t('ui.providers-schedule.open-general')}
            </Button>
          </Notice>
        )}
        <CliEndpointSection key={item} kind={item} onOpenModels={onOpenModels} />
      </>
    );
  })();

  return (
    <div className={styles.page} data-testid="providers-page" data-endpoint={ep}>
      <Tabs
        aria-label={t('ui.cli-monitor.coding-assistant-sections')}
        value={view}
        onChange={(v) => (v === 'monitor' ? setEp(v) : pick(item))}
        items={[
          {
            value: 'assistants',
            label: t('ui.providers-schedule.assistants'),
            testId: 'providers-view-assistants',
          },
          {
            value: 'monitor',
            label: t('ui.cli-monitor.monitor-sessions'),
            testId: 'providers-endpoint-monitor',
          },
        ]}
      />

      <div className={styles.body}>
        {view === 'monitor' ? (
          <div data-testid="providers-section-monitor">
            <CodingMonitor onOpenedTab={onOpenedTab} onOpenNotify={onOpenNotify} />
          </div>
        ) : (
          <div className={styles.layout}>
            <div
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('ui.providers-schedule.choose-a-coding-assistant')}
              className={styles.picker}
              data-testid="providers-endpoint-tabs"
              onKeyDown={onKey}
            >
              {CLIS.map((b) =>
                navButton(
                  b,
                  <EndpointIcon backend={b} size={20} decorative />,
                  t(ENDPOINT_NAME[b]),
                  statusOf(b),
                ),
              )}
              <span className={styles.pickSep} aria-hidden="true" />
              {navButton(
                'external',
                <SquareTerminal size={20} aria-hidden="true" className={styles.pickIcon} />,
                t('ui.providers-schedule.external-cli'),
                null,
              )}
              {navButton(
                'general',
                <Settings2 size={20} aria-hidden="true" className={styles.pickIcon} />,
                t('ui.chat-settings.general'),
                envBad
                  ? { label: t('ui.providers-schedule.runtime-needs-attention'), tone: 'warn' }
                  : { label: t('ui.providers-schedule.runtime-and-permissions'), tone: 'plain' },
              )}
            </div>
            <div
              id="providers-detail"
              role="tabpanel"
              aria-labelledby={`providers-tab-${item}`}
              className={styles.detail}
            >
              {detail}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
