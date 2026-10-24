/**
 * 「编程助手」页：分段标签「助手 / 监视与会话」。
 * - 助手：一排紧凑的助手选择条（Claude Code / Codex / dsh / Grok / Gemini，带安装状态），
 *   下面是选中助手的分组：版本（检测 / 更新 / 安装）、官方账号、第三方模型入口。
 *   第三方供应商与模型分配（Nomi 对话和各编程助手）都在设置 →「模型」（统一网关），这里只留入口。
 *   下面是「外部 CLI」：用户添加的说 ACP 的编程助手（§5.9）。
 * - 监视与会话：本机编程助手进度监视设置 + 活跃会话列表。
 * 切换标签只是换一个视图，不会改任何配置。
 */
import { t, Tabs } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { useProviderEndpoint } from '../../hooks/useProviderEndpoint';
import { isCliKind, type CliKind } from '../../services/cliSource';
import { cliUpdateClient, type CliInstallInfo } from '../../services/cliUpdateClient';
import { harnessClient } from '../../services/harnessClient';
import { CONVERSATION_BACKENDS } from '../../types/chat';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { CodingMonitor } from '../CodingMonitor';
import { EndpointIcon } from '../EndpointIcon';

import { CliEndpointSection } from './CliEndpointSection';
import { ExternalClis } from './ExternalClis';
import styles from './index.module.css';

/** 助手选择条的顺序：与对话区端点顺序一致，去掉 Nomi（Nomi 的模型在「模型」页） */
const CLIS = CONVERSATION_BACKENDS.filter((b): b is CliKind => b !== 'nomi');

type Tone = 'ok' | 'warn' | 'off';

export const ProvidersPage: React.FC<{
  onOpenedTab?: () => void;
  onOpenNotify?: () => void;
  onOpenModels?: () => void;
}> = ({ onOpenedTab, onOpenNotify, onOpenModels }) => {
  const [ep, setEp] = useProviderEndpoint();
  const cliOk = harnessClient.available();
  // 「监视与会话」时记住上次看的助手；旧的「nomi」选中值落到第一个助手
  const [lastCli, setLastCli] = useState<CliKind>(() => (isCliKind(ep) ? ep : CLIS[0]!));
  const cli: CliKind = isCliKind(ep) ? ep : lastCli;
  const view = ep === 'monitor' ? 'monitor' : 'assistants';
  const pick = (k: CliKind) => {
    setLastCli(k);
    setEp(k);
  };

  // 选择条上的安装状态：复用「版本」分组的 cliUpdateClient.inspect（只读，不触发联网检查）
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
    if (!info.path) return { label: t('未安装'), tone: 'off' };
    if (info.updateAvailable) return { label: t('有新版本'), tone: 'warn' };
    return { label: info.version ? t('已安装 {0}', info.version) : t('已安装'), tone: 'ok' };
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = CLIS.indexOf(cli);
    const n = CLIS.length;
    pick(CLIS[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]!);
    e.preventDefault();
  };

  return (
    <div className={styles.page} data-testid="providers-page" data-endpoint={ep}>
      <Tabs
        aria-label={t('编程助手分区')}
        value={view}
        onChange={(v) => (v === 'monitor' ? setEp('monitor') : pick(cli))}
        items={[
          { value: 'assistants', label: t('助手'), testId: 'providers-view-assistants' },
          { value: 'monitor', label: t('监视与会话'), testId: 'providers-endpoint-monitor' },
        ]}
      />

      {view === 'monitor' ? (
        <div data-testid="providers-section-monitor">
          <CodingMonitor onOpenedTab={onOpenedTab} onOpenNotify={onOpenNotify} />
        </div>
      ) : (
        <>
          <div
            role="tablist"
            aria-label={t('选择编程助手')}
            className={styles.picker}
            data-testid="providers-endpoint-tabs"
            onKeyDown={onKey}
          >
            {CLIS.map((b) => {
              const st = statusOf(b);
              const on = cli === b;
              return (
                <button
                  key={b}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  className={`${styles.pick} ${on ? styles.pickOn : ''}`}
                  data-testid={`providers-endpoint-${b}`}
                  onClick={() => pick(b)}
                >
                  <EndpointIcon backend={b} size={20} decorative />
                  <span className={styles.pickText}>
                    <span className={styles.pickName}>{t(ENDPOINT_NAME[b])}</span>
                    {st && (
                      <span
                        className={styles.pickStatus}
                        data-tone={st.tone}
                        data-testid={`providers-endpoint-status-${b}`}
                      >
                        {st.label}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {cliOk ? (
            <>
              <CliEndpointSection key={cli} kind={cli} onOpenModels={onOpenModels} />
              <ExternalClis onOpenedTab={onOpenedTab} />
            </>
          ) : (
            <p className={styles.sub}>{t('编程助手接入需要在桌面应用中使用')}</p>
          )}
        </>
      )}
    </div>
  );
};
