/**
 * 设置 → 通用 → 外观 → 聊天背景：跟随主题 / 纯色 / 图片（分段单选），选了纯色或图片后再出现
 * 颜色 / 图片、左 / 中 / 右三栏模糊与透明度几行；恢复默认。
 * 铺满整个工作台；主进程 chat/ChatBackgroundService.ts（chat-bg:*）。
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

type BlurKey = 'blurLeft' | 'blurCenter' | 'blurRight';
const BLURS: { key: BlurKey; label: string; testId: string }[] = [
  { key: 'blurLeft', label: 'ui.chat-settings.sidebar-blur', testId: 'chat-bg-blur-left' },
  { key: 'blurCenter', label: 'ui.chat-settings.chat-area-blur', testId: 'chat-bg-blur-center' },
  { key: 'blurRight', label: 'ui.chat-settings.right-panels-blur', testId: 'chat-bg-blur-right' },
];

const MODES: { id: ChatBgMode; label: string }[] = [
  { id: 'default', label: 'ui.chat-settings.follow-theme' },
  { id: 'solid', label: 'ui.chat-settings.solid-color' },
  { id: 'image', label: 'ui.providers-schedule.image' },
];

export const ChatBackgroundSettings: React.FC = () => {
  const [s, setS] = useState<ChatBackgroundState>(getChatBackground);
  useEffect(() => subscribeChatBackground(setS), []);

  const patch = (p: Partial<ChatBackgroundState>) => void setChatBackground(p).then(setS);

  const pristine =
    s.mode === 'default' &&
    BLURS.every((b) => s[b.key] === 0) &&
    s.opacity === DEFAULT_CHAT_BG.opacity;

  return (
    <>
      <SettingRow
        data-testid="settings-chat-bg"
        title={t('ui.chat-settings.chat-background')}
        description={t('ui.chat-settings.covers-the-whole-workbench-the-sidebar-chat-area')}
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
            {t('ui.providers-schedule.restore-defaults')}
          </Button>
        )}
        <SegmentedControl
          aria-label={t('ui.chat-settings.chat-background')}
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
        <SettingRow title={t('ui.chat-settings.color')} description={s.solidColor}>
          <input
            type="color"
            className={styles.colorInput}
            value={s.solidColor}
            aria-label={t('ui.chat-settings.color')}
            data-testid="chat-bg-color"
            onChange={(e) => patch({ solidColor: e.target.value })}
          />
        </SettingRow>
      )}

      {s.mode === 'image' && (
        <SettingRow
          title={t('ui.providers-schedule.image')}
          description={
            s.imageUrl ? (
              <span data-testid="chat-bg-image-set">{t('ui.chat-settings.image-selected')}</span>
            ) : (
              t('ui.chat-settings.no-image-yet')
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
            {t('ui.chat-settings.choose-image')}
          </Button>
        </SettingRow>
      )}

      {s.mode !== 'default' && (
        <>
          {BLURS.map((b) => (
            <SettingRow key={b.key} title={t(b.label)}>
              <input
                type="range"
                className={styles.range}
                min={0}
                max={40}
                step={1}
                value={s[b.key]}
                aria-label={t(b.label)}
                data-testid={b.testId}
                onChange={(e) => patch({ [b.key]: Number(e.target.value) })}
              />
              <span className={styles.sizeValue}>{s[b.key]}px</span>
            </SettingRow>
          ))}
          <SettingRow title={t('ui.chat-settings.opacity')}>
            <input
              type="range"
              className={styles.range}
              min={5}
              max={100}
              step={1}
              value={Math.round(s.opacity * 100)}
              aria-label={t('ui.chat-settings.opacity')}
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
