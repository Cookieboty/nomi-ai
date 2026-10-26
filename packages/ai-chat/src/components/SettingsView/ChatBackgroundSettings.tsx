/** 图片主题的图片选择、全局毛玻璃模糊与透明度。 */
import { Button, SettingRow, t } from '@nomi-ai/ui';
import { ImagePlus, RotateCcw } from 'lucide-react';
import React, { useState, useSyncExternalStore } from 'react';

import {
  DEFAULT_CHAT_BG,
  CHAT_BG_PRESET_URL,
  chatBgErrorMessage,
  getChatBackground,
  pickChatBackgroundImage,
  resetChatBackground,
  setChatBackground,
  subscribeChatBackground,
  type ChatBackgroundState,
} from '../../services/chatBackground';

import styles from './index.module.css';

export const ChatBackgroundSettings: React.FC = () => {
  // useSyncExternalStore：首次渲染与订阅生效之间到达的主进程初始值也不会丢
  const state = useSyncExternalStore(subscribeChatBackground, getChatBackground);
  const [pickError, setPickError] = useState<string | null>(null);
  const pick = () =>
    void pickChatBackgroundImage().then(
      () => setPickError(null),
      (error: unknown) => setPickError(chatBgErrorMessage(error)),
    );

  const patch = (value: Partial<ChatBackgroundState>) => void setChatBackground(value);
  const pristine =
    (!state.imageUrl || state.imageUrl === CHAT_BG_PRESET_URL) &&
    state.blur === DEFAULT_CHAT_BG.blur &&
    state.opacity === DEFAULT_CHAT_BG.opacity;

  return (
    <>
      <SettingRow
        data-testid="image-theme-settings"
        title={t('ui.providers-schedule.image')}
        description={
          <>
            {state.imageUrl ? (
              <span data-testid="chat-bg-image-set">
                {state.imageUrl === CHAT_BG_PRESET_URL
                  ? t('ui.chat-settings.preset-image')
                  : t('ui.chat-settings.image-selected')}
              </span>
            ) : (
              t('ui.chat-settings.no-image-yet')
            )}
            {pickError && (
              <span className={styles.warnBlock} role="alert" data-testid="chat-bg-pick-error">
                {pickError}
              </span>
            )}
          </>
        }
      >
        {state.imageUrl && (
          <span
            className={styles.bgThumb}
            style={{ backgroundImage: `url("${state.imageUrl.replace(/"/g, '\\"')}")` }}
            aria-hidden
          />
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="chat-bg-pick"
          onClick={pick}
        >
          <ImagePlus size={14} strokeWidth={1.75} aria-hidden />
          {t('ui.chat-settings.choose-image')}
        </Button>
        {!pristine && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="chat-bg-reset"
            onClick={() => void resetChatBackground()}
          >
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
            {t('ui.providers-schedule.restore-defaults')}
          </Button>
        )}
      </SettingRow>
      <SettingRow title={t('ui.voice-mascot.frosted-glass')}>
        <input
          type="range"
          className={styles.range}
          min={0}
          max={40}
          step={1}
          value={state.blur}
          aria-label={t('ui.voice-mascot.frosted-glass')}
          data-testid="chat-bg-blur"
          onChange={(event) => patch({ blur: Number(event.target.value) })}
        />
        <span className={styles.sizeValue}>{state.blur}px</span>
      </SettingRow>
      <SettingRow title={t('ui.chat-settings.opacity')}>
        <input
          type="range"
          className={styles.range}
          min={5}
          max={100}
          step={1}
          value={Math.round(state.opacity * 100)}
          aria-label={t('ui.chat-settings.opacity')}
          data-testid="chat-bg-opacity"
          onChange={(event) => patch({ opacity: Number(event.target.value) / 100 })}
        />
        <span className={styles.sizeValue}>{Math.round(state.opacity * 100)}%</span>
      </SettingRow>
    </>
  );
};
