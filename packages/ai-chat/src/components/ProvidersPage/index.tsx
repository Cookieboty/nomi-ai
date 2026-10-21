/**
 * 「编程助手」页：顶部标签 Nomi / Claude Code / Codex / dsh / Grok / Gemini / 监视与会话。
 * - 四个端点各自独立：Nomi 的第三方供应商与模型分配已移到设置 →「模型」（统一网关），这里只留一个入口；
 *   Claude Code / Codex / dsh / Grok 用与 Nomi 相同的供应商卡片交互（预设模板、添加 / 编辑 / 启用 / 测速 / 删除），
 *   默认「使用 CLI 自带登录/默认配置」；每个 CLI 端点还有「版本」卡片（检测 / 更新 / 安装）与「高级」（本地路由）。
 * - 监视与会话：本机编程助手进度监视设置 + 活跃会话列表。
 * 切换标签只是换一个视图，不会改任何配置。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { Radio } from 'lucide-react';
import React from 'react';

import { useProviderEndpoint } from '../../hooks/useProviderEndpoint';
import { cliProviderClient } from '../../services/cliProviderClient';
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
  const cliOk = cliProviderClient.available();

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
            '管理 Nomi 和 Claude Code / Codex / dsh / Grok：版本、第三方供应商与本地路由，以及本机编程助手的进度监视。每个端点的配置互相独立，在这里切换只是换一个视图。',
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
        <CliEndpointSection key={ep} kind={ep} />
      ) : (
        <p className={styles.sub}>{t('编程助手接入需要在桌面应用中使用')}</p>
      )}
    </div>
  );
};
