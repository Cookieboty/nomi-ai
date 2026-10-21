/**
 * 单个 CLI 端点（Claude Code / Codex / dsh / Grok / Gemini）的页面：版本卡片（检测 / 更新 / 安装）→
 * 官方账号（dsh 没有）→ 第三方模型的入口。
 * 第三方模型统一在设置 →「模型」里配置（docs/design/unified-gateway.md §4.1），这里不再有按 CLI 的供应商列表。
 */
import { Button, t } from '@nomi-ai/ui';
import React from 'react';

import type { CliKind } from '../../services/cliSource';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import { CliVersionCard } from './CliVersionCard';
import styles from './index.module.css';
import { OfficialAccounts } from './OfficialAccounts';

export const CliEndpointSection: React.FC<{ kind: CliKind; onOpenModels?: () => void }> = ({
  kind,
  onOpenModels,
}) => (
  <div className={styles.section} data-testid={`providers-section-${kind}`}>
    <CliVersionCard kind={kind} />

    {kind !== 'dsh' && <OfficialAccounts kind={kind} />}

    <section className={styles.card} data-testid={`cli-third-party-${kind}`}>
      <h3 className={styles.cardTitle}>{t('第三方模型')}</h3>
      <p className={styles.sub}>
        {t(
          '{0} 的第三方模型在「模型」页统一设置，经 Nomi 网关转换协议。每个标签可以在对话区右上角选用官方账号或第三方，互不影响，也不改 CLI 的全局配置。',
          ENDPOINT_NAME[kind],
        )}
      </p>
      {onOpenModels && (
        <div>
          <Button variant="secondary" onClick={onOpenModels} data-testid="cli-open-models">
            {t('在「模型」页设置第三方模型')}
          </Button>
        </div>
      )}
    </section>
  </div>
);
