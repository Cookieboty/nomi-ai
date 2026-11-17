/**
 * 新会话的示例问题卡片（打招呼 / 写代码 / 整理待办等）：放在聊天输入框下方。
 * 问题按新手引导里选的职业与兴趣推荐（services/recommendations），点击即直接发送。
 * 空态判定与渲染位置在 App 层（footer 里，输入框之后）。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  IconArrowUpRight,
  IconCheckupList,
  IconCode,
  IconFileText,
  IconLanguage,
  IconMessageCircle,
  IconPencil,
  IconSchool,
} from '@tabler/icons-react';
import React from 'react';

import { useAiChatActions } from '../../contexts/aiChatStore';
import { useUserProfile } from '../../hooks/useUserProfile';
import { QUICK_PROMPT_TEXT, recommend } from '../../services/recommendations';

import styles from './PromptCards.module.css';

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

export const PromptCards: React.FC = () => {
  const { actions } = useAiChatActions();
  // 示例问题按新手引导里选的职业与兴趣推荐
  const prompts = recommend(useUserProfile()).prompts;
  if (!prompts.length) return null;
  return (
    <div className={styles.prompts} data-testid="welcome-prompts">
      {prompts.map((id) => (
        <button
          type="button"
          key={id}
          className={styles.prompt}
          data-testid={`quick-action-${id}`}
          onClick={() => actions.sendMessage(t(QUICK_PROMPT_TEXT[id].prompt))}
        >
          <Icon icon={PROMPT_ICON[id]} size={18} />
          <span>{t(QUICK_PROMPT_TEXT[id].label)}</span>
          <Icon icon={IconArrowUpRight} size={14} className={styles.promptArrow} />
        </button>
      ))}
    </div>
  );
};
