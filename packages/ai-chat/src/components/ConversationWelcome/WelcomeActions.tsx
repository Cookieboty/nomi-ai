/**
 * 空会话主对话输入框下方的内容：
 * - 还没有可用模型（none / unassigned）：常驻显示「添加模型 / 选择模型」引导卡，隐藏示例问题（点了也只会报错）；
 * - 模型就绪或状态还没读到：示例问题卡片（PromptCards）。
 * 引导卡默认可见、按钮可用键盘 Tab 聚焦 / 触屏点按，不依赖鼠标悬停。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { IconArrowUpRight, IconSparkles } from '@tabler/icons-react';
import React from 'react';

import { useNomiModelStatus, type NomiModelStatus } from '../../hooks/useNomiModelStatus';

import styles from './ModelSetupCard.module.css';
import { PromptCards } from './PromptCards';

export const ModelSetupCard: React.FC<{
  status: 'none' | 'unassigned';
  onOpenModels: () => void;
}> = ({ status, onOpenModels }) => {
  const none = status === 'none';
  const title = t(
    none ? 'ui.foundation.welcome-connect-model' : 'ui.foundation.welcome-select-model',
  );
  return (
    <section
      className={styles.card}
      aria-label={title}
      data-testid="welcome-needs-model"
      data-status={status}
    >
      <Icon icon={IconSparkles} size={18} className={styles.icon} />
      <div className={styles.copy}>
        <span className={styles.title}>{title}</span>
        <span className={styles.description}>
          {t(
            none
              ? 'ui.foundation.nomi-has-no-model-yet-add-one-to-start'
              : 'ui.foundation.pick-one-of-your-models-for-nomi-chat',
          )}
        </span>
      </div>
      <Button variant="ghost" size="sm" onClick={onOpenModels} data-testid="welcome-add-model">
        {t(none ? 'ui.foundation.getting-started-add-a-model' : 'ui.models.choose-a-model')}
        <Icon icon={IconArrowUpRight} size={14} />
      </Button>
    </section>
  );
};

export const WelcomeActions: React.FC<{
  onOpenModels: () => void;
  /** 显式指定状态（测试用）；不传则读网关状态 */
  status?: NomiModelStatus | null;
}> = ({ onOpenModels, status: injected }) => {
  const fromGateway = useNomiModelStatus();
  const status = injected !== undefined ? injected : fromGateway;
  if (status === 'none' || status === 'unassigned')
    return <ModelSetupCard status={status} onOpenModels={onOpenModels} />;
  return <PromptCards />;
};
