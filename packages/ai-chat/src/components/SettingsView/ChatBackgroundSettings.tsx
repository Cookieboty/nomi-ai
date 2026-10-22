/**
 * 设置 → 通用 → 外观 → 聊天背景：跟随主题 / 纯色 / 图片（分段单选），选了纯色或图片后再出现
 * 颜色 / 图片、模糊与透明度几行；恢复默认。
 * 仅对话主面板；主进程 chat/ChatBackgroundService.ts（chat-bg:*）。
 */
import { Button, SegmentedControl, SettingRow, t } from '@nomi-ai/ui';
import { ImagePlus, RotateCcw } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import {
  DEFAULT_CHAT_BG,
  getChatBackground,
  pickChatBackgroundImage,
  resetChatBackground,
  setChatBackground,
  subscribeChatBackground,
  type ChatBackgroundState,
  type ChatBgMode,
} from '../../services/chatBackground';

import styles from './index.module.css';

const MODES: { id: ChatBgMode; label: string }[] = [
  { id: 'default', label: '跟随主题' },
  { id: 'solid', label: '纯色' },
  { id: 'image', label: '图片' },
];

export const ChatBackgroundSettings: React.FC = () => {
  const [s, setS] = useState<ChatBackgroundState>(getChatBackground);
  useEffect(() => subscribeChatBackground(setS), []);

  const patch = (p: Partial<ChatBackgroundState>) => void setChatBackground(p).then(setS);

  const pristine = s.mode === 'default' && s.blur === 0 && s.opacity === DEFAULT_CHAT_BG.opacity;

  return (
    <>
      <SettingRow
        data-testid="settings-chat-bg"
        title={t('聊天背景')}
        description={t('只改变对话主面板的背景，不影响侧栏与窗口其它区域。')}
      >
        {!pristine && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="chat-bg-reset"
            onClick={() => void resetChatBackground().then(setS)}
          >
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
            {t('恢复默认')}
          </Button>
        )}
        <SegmentedControl
          aria-label={t('聊天背景')}
          value={s.mode}
          onChange={(mode) => patch({ mode })}
          options={MODES.map((m) => ({
            value: m.id,
            label: t(m.label),
            testId: `chat-bg-mode-${m.id}`,
          }))}
        />
      </SettingRow>

      {s.mode === 'solid' && (
        <SettingRow title={t('颜色')} description={s.solidColor}>
          <input
            type="color"
            className={styles.colorInput}
            value={s.solidColor}
            aria-label={t('颜色')}
            data-testid="chat-bg-color"
            onChange={(e) => patch({ solidColor: e.target.value })}
          />
        </SettingRow>
      )}

      {s.mode === 'image' && (
        <SettingRow
          title={t('图片')}
          description={
            s.imageUrl ? (
              <span data-testid="chat-bg-image-set">{t('已选择图片')}</span>
            ) : (
              t('尚未选择图片')
            )
          }
        >
          {s.imageUrl && (
            <span
              className={styles.bgThumb}
              style={{ backgroundImage: `url("${s.imageUrl.replace(/"/g, '\\"')}")` }}
              aria-hidden
            />
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="chat-bg-pick"
            onClick={() => void pickChatBackgroundImage().then(setS)}
          >
            <ImagePlus size={14} strokeWidth={1.75} aria-hidden />
            {t('选择图片…')}
          </Button>
        </SettingRow>
      )}

      {s.mode !== 'default' && (
        <>
          <SettingRow title={t('模糊')}>
            <input
              type="range"
              className={styles.range}
              min={0}
              max={40}
              step={1}
              value={s.blur}
              aria-label={t('模糊')}
              data-testid="chat-bg-blur"
              onChange={(e) => patch({ blur: Number(e.target.value) })}
            />
            <span className={styles.sizeValue}>{s.blur}px</span>
          </SettingRow>
          <SettingRow title={t('透明度')}>
            <input
              type="range"
              className={styles.range}
              min={5}
              max={100}
              step={1}
              value={Math.round(s.opacity * 100)}
              aria-label={t('透明度')}
              data-testid="chat-bg-opacity"
              onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })}
            />
            <span className={styles.sizeValue}>{Math.round(s.opacity * 100)}%</span>
          </SettingRow>
        </>
      )}
    </>
  );
};
