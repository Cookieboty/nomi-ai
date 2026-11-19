/**
 * Agent（CLI）空会话在「待选模型」或「尚未登录 / 未配置供应商」时的内联引导卡：
 * 与 Nomi 的 ModelSetupCard 对称，复用相同卡片样式（ModelSetupCard.module.css），
 * 让用户就地打开模型选择器或跳转到 Agents / 供应商设置，而不是盲目发消息撞墙。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { IconArrowUpRight, IconSparkles } from '@tabler/icons-react';
import React from 'react';

import type { CliTabReadiness } from '../../hooks/useCliTabReadiness';
import { isCliKind, tabSourceOf } from '../../services/cliSource';
import type { HarnessTabMeta } from '../../services/harnessClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './ModelSetupCard.module.css';

export interface CliWelcomeActionsProps {
  tab: HarnessTabMeta;
  readiness: CliTabReadiness;
  onPickModel: () => void;
  onOpenSetup: () => void;
  onOpenProviders: () => void;
}

export const CliWelcomeActions: React.FC<CliWelcomeActionsProps> = ({
  tab,
  readiness,
  onPickModel,
  onOpenSetup,
  onOpenProviders,
}) => {
  if (readiness.status === 'ready' || readiness.status === 'loading') {
    return null;
  }

  const backendName = isCliKind(tab.backend) ? t(ENDPOINT_NAME[tab.backend]) : tab.backend;

  if (readiness.status === 'needs-model') {
    const title = t('ui.foundation.welcome-select-model');
    const description =
      tabSourceOf(tab) === 'thirdParty'
        ? t('ui.models.cli-welcome-select-model-desc', backendName)
        : (readiness.reason ?? t('ui.models.cli-welcome-select-model-desc', backendName));
    return (
      <section
        className={styles.card}
        aria-label={title}
        data-testid="cli-welcome-needs-model"
        data-status={readiness.status}
      >
        <Icon icon={IconSparkles} size={18} className={styles.icon} />
        <div className={styles.copy}>
          <span className={styles.title}>{title}</span>
          <span className={styles.description}>{description}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onPickModel}
          data-testid="cli-welcome-pick-model"
        >
          {t('ui.models.choose-a-model')}
          <Icon icon={IconArrowUpRight} size={14} />
        </Button>
      </section>
    );
  }

  const setupTitle = t('ui.models.cli-welcome-setup-title');
  const setupDesc =
    readiness.reason ??
    t(
      readiness.thirdPartyOnly
        ? 'ui.models.cli-welcome-setup-desc-tp-only'
        : 'ui.models.cli-welcome-setup-desc',
      backendName,
    );
  return (
    <section
      className={styles.card}
      aria-label={setupTitle}
      data-testid="cli-welcome-needs-setup"
      data-status={readiness.status}
    >
      <Icon icon={IconSparkles} size={18} className={styles.icon} />
      <div className={styles.copy}>
        <span className={styles.title}>{setupTitle}</span>
        <span className={styles.description}>{setupDesc}</span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={readiness.thirdPartyOnly ? onOpenProviders : onOpenSetup}
        data-testid="cli-welcome-configure"
      >
        {t('ui.models.cli-welcome-configure')}
        <Icon icon={IconArrowUpRight} size={14} />
      </Button>
    </section>
  );
};
