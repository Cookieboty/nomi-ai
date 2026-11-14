/** 新会话的轻量欢迎区；发送、模型配置与推荐仍由调用方处理。 */
import { Button, Icon, t } from '@nomi-ai/ui';
import {
  IconArrowUpRight,
  IconCheckupList,
  IconCode,
  IconFileText,
  IconLanguage,
  IconMessageCircle,
  IconPencil,
  IconSchool,
  IconSparkles,
} from '@tabler/icons-react';
import React from 'react';

import { QUICK_PROMPT_TEXT, type QuickPromptId } from '../../services/recommendations';
import type { EndpointKey } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import styles from './index.module.css';

const PROMPT_ICON = {
  hello: IconMessageCircle,
  code: IconCode,
  todo: IconCheckupList,
  weekly: IconFileText,
  spec: IconFileText,
  write: IconPencil,
  language: IconLanguage,
  learn: IconSchool,
};

export const ConversationWelcome: React.FC<{
  backend?: EndpointKey;
  title: string;
  description?: string;
  modelStatus?: 'none' | 'unassigned';
  onOpenModels?: () => void;
  prompts?: readonly QuickPromptId[];
  onPrompt?: (id: QuickPromptId) => void;
}> = ({ backend = 'nomi', title, description, modelStatus, onOpenModels, prompts, onPrompt }) => (
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
      {modelStatus && (
        <div className={styles.setup} data-testid="welcome-needs-model" data-status={modelStatus}>
          <Icon icon={IconSparkles} size={18} className={styles.setupIcon} />
          <div className={styles.setupCopy}>
            <span className={styles.setupTitle}>
              {t(
                modelStatus === 'none'
                  ? 'ui.foundation.welcome-connect-model'
                  : 'ui.foundation.welcome-select-model',
              )}
            </span>
            <span className={styles.setupDescription}>
              {t(
                modelStatus === 'none'
                  ? 'ui.foundation.nomi-has-no-model-yet-add-one-to-start'
                  : 'ui.foundation.pick-one-of-your-models-for-nomi-chat',
              )}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={onOpenModels} data-testid="welcome-add-model">
            {t(
              modelStatus === 'none'
                ? 'ui.foundation.getting-started-add-a-model'
                : 'ui.models.choose-a-model',
            )}
            <Icon icon={IconArrowUpRight} size={14} />
          </Button>
        </div>
      )}
      {!!prompts?.length && (
        <div className={styles.prompts}>
          {prompts.map((id) => (
            <button
              type="button"
              key={id}
              className={styles.prompt}
              data-testid={`quick-action-${id}`}
              onClick={() => onPrompt?.(id)}
            >
              <Icon icon={PROMPT_ICON[id]} size={18} />
              <span>{t(QUICK_PROMPT_TEXT[id].label)}</span>
              <Icon icon={IconArrowUpRight} size={14} className={styles.promptArrow} />
            </button>
          ))}
        </div>
      )}
      {backend === 'nomi' && (
        <p className={styles.hint}>
          {t('ui.foundation.type-for-commands-for-knowledge-base-voice-models')}
        </p>
      )}
    </div>
  </div>
);
