/**
 * 设置 → 通用 → 聊天背景：主题色 / 纯色 / 图片，模糊与透明度，重置。
 * 仅对话主面板；主进程 chat/ChatBackgroundService.ts（chat-bg:*）。
 */
import { Button, t } from '@nomi-ai/ui';
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

  return (
    <section className={styles.block} data-testid="settings-chat-bg">
      <h2 className={styles.h2}>{t('聊天背景')}</h2>
      <p className={styles.muted}>
        {t(
          '只改变对话主面板的背景，不影响侧栏与窗口其它区域。可选纯色或图片，并调节模糊与透明度。',
        )}
      </p>

      <div className={styles.bgModes} role="radiogroup" aria-label={t('聊天背景')}>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={s.mode === m.id}
            data-testid={`chat-bg-mode-${m.id}`}
            className={`${styles.bgMode} ${s.mode === m.id ? styles.bgModeOn : ''}`}
            onClick={() => patch({ mode: m.id })}
          >
            {t(m.label)}
          </button>
        ))}
      </div>

      {s.mode === 'solid' && (
        <label className={styles.bgRow}>
          <span>{t('颜色')}</span>
          <input
            type="color"
            value={s.solidColor}
            data-testid="chat-bg-color"
            onChange={(e) => patch({ solidColor: e.target.value })}
          />
          <span className={styles.muted}>{s.solidColor}</span>
        </label>
      )}

      {s.mode === 'image' && (
        <div className={styles.bgRow}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="chat-bg-pick"
            onClick={() => void pickChatBackgroundImage().then(setS)}
          >
            <ImagePlus size={16} strokeWidth={1.75} aria-hidden />
            {t('选择图片…')}
          </Button>
          {s.imageUrl ? (
            <span className={styles.muted} data-testid="chat-bg-image-set">
              {t('已选择图片')}
            </span>
          ) : (
            <span className={styles.muted}>{t('尚未选择图片')}</span>
          )}
          {s.imageUrl && (
            <span
              className={styles.bgThumb}
              style={{ backgroundImage: `url("${s.imageUrl.replace(/"/g, '\\"')}")` }}
              aria-hidden
            />
          )}
        </div>
      )}

      {s.mode !== 'default' && (
        <>
          <label className={styles.bgRow}>
            <span>{t('模糊')}</span>
            <input
              type="range"
              className={styles.range}
              min={0}
              max={40}
              step={1}
              value={s.blur}
              data-testid="chat-bg-blur"
              onChange={(e) => patch({ blur: Number(e.target.value) })}
            />
            <span className={styles.muted}>{s.blur}px</span>
          </label>
          <label className={styles.bgRow}>
            <span>{t('透明度')}</span>
            <input
              type="range"
              className={styles.range}
              min={5}
              max={100}
              step={1}
              value={Math.round(s.opacity * 100)}
              data-testid="chat-bg-opacity"
              onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })}
            />
            <span className={styles.muted}>{Math.round(s.opacity * 100)}%</span>
          </label>
        </>
      )}

      <div className={styles.actions}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="chat-bg-reset"
          disabled={s.mode === 'default' && s.blur === 0 && s.opacity === DEFAULT_CHAT_BG.opacity}
          onClick={() => void resetChatBackground().then(setS)}
        >
          <RotateCcw size={16} strokeWidth={1.75} aria-hidden />
          {t('恢复默认背景')}
        </Button>
      </div>
    </section>
  );
};
