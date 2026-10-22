/**
 * 「编程助手」页：顶部标签 Nomi / Claude Code / Codex / dsh / Grok / Gemini / 监视与会话。
 * - 第三方供应商与模型分配（Nomi 对话和各编程助手）都在设置 →「模型」（统一网关），这里只留入口；
 *   每个 CLI 端点有「版本」卡片（检测 / 更新 / 安装）和官方账号。
 * - 监视与会话：本机编程助手进度监视设置 + 活跃会话列表。
 * 切换标签只是换一个视图，不会改任何配置。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { Radio } from 'lucide-react';
import React from 'react';

import { useProviderEndpoint } from '../../hooks/useProviderEndpoint';
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
        <h2 className={styles.title}>{t('编程助手')}</h2>
        <p className={styles.sub}>
          {t(
            '管理 Claude Code / Codex / dsh / Grok / Gemini 的版本与官方账号，以及本机编程助手的进度监视。第三方模型在「模型」页设置。',
          )}
        </p>
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
              <EndpointIcon backend={b} size={16} decorative />
              {t(ENDPOINT_NAME[b])}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={ep === 'monitor'}
            tabIndex={ep === 'monitor' ? 0 : -1}
            className={`${styles.tab} ${styles.tabMonitor} ${ep === 'monitor' ? styles.tabOn : ''}`}
            data-testid="providers-endpoint-monitor"
            onClick={() => setEp('monitor')}
          >
            <Icon icon={Radio} />
            {t('监视与会话')}
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
