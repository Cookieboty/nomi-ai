/**
 * 输入框被「文件预览属于原会话」挡着时的可见说明。
 *
 * 原来只在预览页里写一行小字，用户切到主对话、盯着禁用的输入框完全不知道原因。这里和预览页同一套
 * 判断（useResourcePreview 的 sendBlocked）出两种形态：
 *   - banner：输入框上方常驻一行（通知），键盘焦点 / 读屏都能读到；
 *   - floating：输入框是空会话居中的时候，footer 在整块中间，常驻一行会把输入框顶歪——
 *     改成贴在输入框下沿的卡片，和「添加模型」引导卡同一个位置（绝对定位，不占布局）。
 * 两种情况都可点：有原会话就跳回去（原来的「回到原会话」按钮只出现在已经关掉的预览页里，根本点不到）。
 */
import { Icon, t } from '@nomi-ai/ui';
import { IconArrowBackUp, IconInfoCircle, IconX } from '@tabler/icons-react';
import React from 'react';

import type { SendBlockedReason } from '../../hooks/useResourcePreview';

import styles from './SendBlockedHint.module.css';

export interface SendBlockedHintProps {
  reason: SendBlockedReason;
  /** 空会话：贴在输入框下沿，不挤动居中的版面 */
  floating?: boolean;
  /** 回到预览所属的那个会话（预览就属于当前会话时：关掉预览） */
  onReturn: () => void;
}

export const SendBlockedHint: React.FC<SendBlockedHintProps> = ({ reason, floating, onReturn }) => {
  const sameSession = !!reason.previewId && reason.previewId === reason.scopeId;
  const message = t(
    sameSession
      ? 'ui.session-workspace.composer-preview-send-blocked'
      : 'ui.session-workspace.composer-preview-other-conversation',
  );
  return (
    <p
      className={`${styles.hint} ${floating ? styles.floating : ''}`}
      role="status"
      data-testid="composer-send-blocked"
      data-floating={floating ? 'true' : undefined}
    >
      <Icon icon={IconInfoCircle} size={14} className={styles.icon} />
      <span className={styles.text}>{message}</span>
      <button
        type="button"
        className={styles.action}
        onClick={onReturn}
        data-testid="composer-send-blocked-return"
      >
        <Icon icon={sameSession ? IconX : IconArrowBackUp} size={14} />
        {t(
          sameSession
            ? 'ui.session-workspace.close-preview'
            : 'ui.session-workspace.composer-preview-return',
        )}
      </button>
    </p>
  );
};
