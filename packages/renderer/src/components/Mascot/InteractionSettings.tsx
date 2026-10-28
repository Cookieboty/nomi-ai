import type { MascotInteractionConfig } from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';
import { Button, Modal, Switch } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import styles from './style.module.css';

import { useMascot } from '@/contexts/MascotContext';
import { interactionSettings } from '@/mascot/interaction/settings';
import { api, hasTransport } from '@/services/api';

const ITEMS: Array<{ key: keyof MascotInteractionConfig; label: string; hint: string }> = [
  {
    key: 'clickThrough',
    label: 'ui.chat-settings.click-through-transparent-areas',
    hint: 'ui.chat-settings.only-clicks-on-the-character-itself-are-captured',
  },
  {
    key: 'gravity',
    label: 'ui.chat-settings.gravity-landing',
    hint: 'ui.chat-settings.off-by-default-she-stays-where-you-drop',
  },
  {
    key: 'wander',
    label: 'ui.chat-settings.stroll-occasionally',
    hint: 'ui.chat-settings.walks-along-the-bottom-of-the-screen-when',
  },
  {
    key: 'reactions',
    label: 'ui.chat-settings.touch-reactions',
    hint: 'ui.chat-settings.expressions-motions-and-lines-when-you-pat-her',
  },
  {
    key: 'globalLook',
    label: 'ui.chat-settings.eyes-follow-the-global-cursor',
    hint: 'ui.chat-settings.looks-at-the-cursor-even-when-it-s',
  },
  {
    key: 'bubbleReplies',
    label: 'ui.chat-settings.show-ai-replies-in-bubble',
    hint: 'ui.chat-settings.after-a-reply-finishes-the-first-sentence-or',
  },
];

/** 互动设置面板（托盘 / 角色选择器 → 互动设置） */
export const InteractionSettings: React.FC = () => {
  const { state, dispatch } = useMascot();
  const [cfg, setCfg] = useState(interactionSettings.get());
  useEffect(() => interactionSettings.subscribe(setCfg), []);
  if (state.panel !== 'interaction') return null;
  return (
    <Modal
      open
      onClose={() => dispatch({ type: 'SET_PANEL', payload: null })}
      title={t('ui.chat-settings.interaction-settings')}
      data-testid="interaction-settings"
    >
      <ul className={styles.settingsList}>
        {ITEMS.map((it) => (
          <li key={it.key}>
            <Switch
              checked={cfg[it.key]}
              onChange={(v) => interactionSettings.set({ [it.key]: v })}
              label={t(it.label)}
              data-testid={`interaction-${it.key}`}
            />
            <p className={styles.settingsHint}>{t(it.hint)}</p>
          </li>
        ))}
      </ul>
      <div className={styles.footer}>
        <Button
          size="sm"
          variant="ghost"
          data-testid="interaction-wander-now"
          onClick={() => {
            if (hasTransport()) void api.mascot.wanderNow().catch(() => undefined);
          }}
        >
          {t('ui.chat-settings.take-a-walk-now')}
        </Button>
      </div>
    </Modal>
  );
};

export default InteractionSettings;
