/**
 * 单个 CLI 端点（Claude Code / Codex / dsh / Grok / Gemini）的分组：版本（检测 / 更新 / 安装）→
 * 本机环境登录 → 官方账号 → 新会话默认用 + 就地第三方主模型及各档位配置。
 */
import React from 'react';

import { supportsCustomLauncher } from '../../services/cliLauncherClient';
import type { CliKind } from '../../services/cliSource';
import { hasOfficialAccount } from '../../utils/cliCaps';

import { CliLauncherCard } from './CliLauncherCard';
import { CliThirdPartyModelsCard } from './CliThirdPartyModelsCard';
import { CliVersionCard } from './CliVersionCard';
import styles from './index.module.css';
import { OfficialAccounts } from './OfficialAccounts';

export const CliEndpointSection: React.FC<{ kind: CliKind; onOpenModels?: () => void }> = ({
  kind,
  onOpenModels,
}) => {
  return (
    <div className={styles.section} data-testid={`providers-section-${kind}`}>
      <CliVersionCard kind={kind} />

      {supportsCustomLauncher(kind) && <CliLauncherCard key={kind} kind={kind} />}

      {hasOfficialAccount(kind) && <OfficialAccounts kind={kind} />}

      <CliThirdPartyModelsCard kind={kind} onOpenModels={onOpenModels} />
    </div>
  );
};
