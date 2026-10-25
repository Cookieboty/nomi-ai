/**
 * 单个 CLI 端点（Claude Code / Codex / dsh / Grok / Gemini）的分组：版本（检测 / 更新 / 安装）→
 * 官方账号（dsh 没有）→ 第三方模型的入口。
 * 第三方模型统一在设置 →「模型」里配置（docs/design/unified-gateway.md §4.1），这里不再有按 CLI 的供应商列表。
 */
import { Button, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import React from 'react';

import type { CliKind } from '../../services/cliSource';
import { hasOfficialAccount } from '../../utils/cliCaps';
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

    {hasOfficialAccount(kind) && <OfficialAccounts kind={kind} />}

    <SettingsGroup
      title={t('ui.models.third-party-models')}
      data-testid={`cli-third-party-${kind}`}
    >
      <SettingRow
        title={t('ui.providers-schedule.set-up-in-models')}
        description={t(
          'ui.providers-schedule.requests-go-through-the-nomi-gateway-which-converts',
          ENDPOINT_NAME[kind],
        )}
      >
        {onOpenModels && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenModels}
            data-testid="cli-open-models"
          >
            {t('ui.models.open-models')}
          </Button>
        )}
      </SettingRow>
    </SettingsGroup>
  </div>
);
