/**
 * 新会话的欢迎区：图标 + 标题 + 小标题。
 * 示例问题卡片（在聊天框下方）与模型引导由调用方处理，见 WelcomeActions（缺模型时的引导卡 / PromptCards）。
 */
import { t } from '@nomi-ai/ui';
import React from 'react';

import type { EndpointKey } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import styles from './index.module.css';

export const ConversationWelcome: React.FC<{
  backend?: EndpointKey;
  title: string;
  description?: string;
}> = ({ backend = 'nomi', title, description }) => (
  <div
    className={styles.screen}
    data-testid={backend === 'nomi' ? 'welcome-screen' : 'cli-tab-empty'}
  >
    <div className={styles.content}>
      <div className={styles.mark} aria-hidden="true">
        <EndpointIcon backend={backend} size={36} decorative />
      </div>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.description}>{description ?? t('ui.foundation.welcome-start-hint')}</p>
    </div>
  </div>
);
