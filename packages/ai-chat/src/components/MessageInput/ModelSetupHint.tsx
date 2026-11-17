/**
 * 输入框的模型引导：还没配好对话模型（none / unassigned）时，鼠标移到输入框上，
 * 在输入框上方浮出一张引导卡：一句说明 + 直接去添加 / 选择模型的按钮。
 * 模型就绪、状态还没读到、或调用方关掉（编程助手标签）时，只把 children 原样渲染。
 *
 * 首屏不常驻这块内容（避免占位），悬停显隐由 CSS 控制（见 ModelSetupHint.module.css）。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { IconArrowUpRight, IconSparkles } from '@tabler/icons-react';
import React from 'react';

import { useNomiModelStatus, type NomiModelStatus } from '../../hooks/useNomiModelStatus';

import styles from './ModelSetupHint.module.css';

export const ModelSetupHint: React.FC<{
  onOpenModels: () => void;
  /** false 时不显示提示（如编程助手标签：那里的模型不是 Nomi 的对话模型） */
  enabled?: boolean;
  /** 显式指定状态（测试用）；不传则读网关状态 */
  status?: NomiModelStatus | null;
  children: React.ReactNode;
}> = ({ onOpenModels, enabled = true, status: injected, children }) => {
  const fromGateway = useNomiModelStatus();
  const status = injected !== undefined ? injected : fromGateway;
  if (!enabled || (status !== 'none' && status !== 'unassigned')) return <>{children}</>;
  const none = status === 'none';
  const title = t(
    none ? 'ui.foundation.welcome-connect-model' : 'ui.foundation.welcome-select-model',
  );
  return (
    <div className={styles.host} data-testid="model-setup-hint-host" data-status={status}>
      {children}
      <div
        className={styles.guide}
        role="dialog"
        aria-label={title}
        data-testid="composer-model-guide"
      >
        <Icon icon={IconSparkles} size={16} className={styles.guideIcon} />
        <div className={styles.guideCopy}>
          <span className={styles.guideTitle}>{title}</span>
          <span className={styles.guideDescription}>
            {t(
              none
                ? 'ui.foundation.nomi-has-no-model-yet-add-one-to-start'
                : 'ui.foundation.pick-one-of-your-models-for-nomi-chat',
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenModels}
          data-testid="model-setup-hint-action"
        >
          {t(none ? 'ui.foundation.getting-started-add-a-model' : 'ui.models.choose-a-model')}
          <Icon icon={IconArrowUpRight} size={14} />
        </Button>
      </div>
    </div>
  );
};
