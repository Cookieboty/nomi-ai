/**
 * 「编程助手」页：顶部助手卡片（带安装状态）Nomi / Claude Code / Codex / dsh / Grok / Gemini / 监视与会话。
 * - 第三方供应商与模型分配（Nomi 对话和各编程助手）都在设置 →「模型」（统一网关），这里只留入口；
 *   每个 CLI 端点有「版本」卡片（检测 / 更新 / 安装）和官方账号。
 * - 监视与会话：本机编程助手进度监视设置 + 活跃会话列表。
 * 切换标签只是换一个视图，不会改任何配置。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { Radio } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { useProviderEndpoint } from '../../hooks/useProviderEndpoint';
import { cliUpdateClient, type CliInstallInfo } from '../../services/cliUpdateClient';
import { harnessClient } from '../../services/harnessClient';
import { CONVERSATION_BACKENDS, type ConversationBackend } from '../../types/chat';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { CodingMonitor } from '../CodingMonitor';
import { EndpointIcon } from '../EndpointIcon';

import { CliEndpointSection } from './CliEndpointSection';
import styles from './index.module.css';

const TABS = [...CONVERSATION_BACKENDS, 'monitor'] as const;

export const ProvidersPage: React.FC<{
  onOpenedTab?: () => void;
  onOpenNotify?: () => void;
  onOpenModels?: () => void;
}> = ({ onOpenedTab, onOpenNotify, onOpenModels }) => {
  const [ep, setEp] = useProviderEndpoint();
  const cliOk = harnessClient.available();
  // 助手卡片上的安装状态：复用「版本」卡片的 cliUpdateClient.inspect（只读，不触发联网检查）
  const [infos, setInfos] = useState<CliInstallInfo[] | null>(null);
  useEffect(() => {
    if (!cliUpdateClient.available()) return;
    let alive = true;
    cliUpdateClient
      .inspect(false)
      .then((rows) => alive && setInfos(Array.isArray(rows) ? rows : []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const statusOf = (b: ConversationBackend): { label: string; ok: boolean } | null => {
    if (b === 'nomi') return { label: t('内置'), ok: true };
    const info = infos?.find((x) => x.kind === b);
    if (!info) return null; // 主进程没报告这个端点：不猜
    return info.path
      ? { label: info.version ? t('已安装 {0}', info.version) : t('已安装'), ok: true }
      : { label: t('未安装'), ok: false };
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.indexOf(ep);
    const n = TABS.length;
    setEp(TABS[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]!);
    e.preventDefault();
  };

  return (
    <div className={styles.page} data-testid="providers-page" data-endpoint={ep}>
      <div className={styles.head}>
        <div
          role="tablist"
          aria-label={t('编程助手分区')}
          className={styles.tabs}
          data-testid="providers-endpoint-tabs"
          onKeyDown={onKey}
        >
          {CONVERSATION_BACKENDS.map((b: ConversationBackend) => (
            <button
              key={b}
              type="button"
              role="tab"
              aria-selected={ep === b}
              tabIndex={ep === b ? 0 : -1}
              className={`${styles.tab} ${ep === b ? styles.tabOn : ''}`}
              data-testid={`providers-endpoint-${b}`}
              onClick={() => setEp(b)}
            >
              <span className={styles.cardName}>
                <EndpointIcon backend={b} size={20} decorative />
                {t(ENDPOINT_NAME[b])}
              </span>
              {(() => {
                const st = statusOf(b);
                return st ? (
                  <span
                    className={`${styles.chip} ${st.ok ? styles.chipOk : ''}`}
                    data-testid={`providers-endpoint-status-${b}`}
                  >
                    {st.label}
                  </span>
                ) : null;
              })()}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={ep === 'monitor'}
            tabIndex={ep === 'monitor' ? 0 : -1}
            className={`${styles.tab} ${ep === 'monitor' ? styles.tabOn : ''}`}
            data-testid="providers-endpoint-monitor"
            onClick={() => setEp('monitor')}
          >
            <span className={styles.cardName}>
              <Icon icon={Radio} />
              {t('监视与会话')}
            </span>
          </button>
        </div>
      </div>

      {ep === 'monitor' ? (
        <div data-testid="providers-section-monitor">
          <CodingMonitor onOpenedTab={onOpenedTab} onOpenNotify={onOpenNotify} />
        </div>
      ) : ep === 'nomi' ? (
        <div data-testid="providers-section-nomi">
          <div className={styles.intro}>
            <p>
              {t(
                'Nomi 对话用的第三方供应商与模型（对话 / 工具调用 / 摘要）在设置 →「模型」里管理。Claude Code / Codex / dsh / Grok 不会读取 Nomi 的配置。',
              )}
            </p>
          </div>
          {onOpenModels && (
            <Button variant="secondary" onClick={onOpenModels} data-testid="providers-open-models">
              {t('打开「模型」')}
            </Button>
          )}
        </div>
      ) : cliOk ? (
        <CliEndpointSection key={ep} kind={ep} onOpenModels={onOpenModels} />
      ) : (
        <p className={styles.sub}>{t('编程助手接入需要在桌面应用中使用')}</p>
      )}
    </div>
  );
};
