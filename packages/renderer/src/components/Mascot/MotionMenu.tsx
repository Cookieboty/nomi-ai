import {
  ACTION_LABELS,
  MOTION_LABELS,
  mascotRegistry,
  playMotionNow,
} from '@nomi-ai/avatar-runtime';
import { t } from '@nomi-ai/ui';
import { Button, Modal } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import styles from './style.module.css';

import { useMascot } from '@/contexts/MascotContext';

/** 动作菜单：列出当前模型可播放的动作（工具栏右键 / 托盘同源）。 */
export const MotionMenu: React.FC = () => {
  const { state, dispatch } = useMascot();
  const [motions, setMotions] = useState<string[]>(
    () => mascotRegistry.current()?.capabilities().motions ?? [],
  );
  useEffect(() => mascotRegistry.subscribe((b) => setMotions(b?.capabilities().motions ?? [])), []);
  if (state.panel !== 'motions') return null;
  const close = () => dispatch({ type: 'SET_PANEL', payload: null });
  const list = motions.filter((m) => m !== 'idle' && m !== 'talk');

  return (
    <Modal open onClose={close} title={t('ui.voice-mascot.motions')} data-testid="motion-menu">
      {list.length === 0 ? (
        <p className={styles.credit}>{t('ui.voice-mascot.motion-library-not-loaded-yet')}</p>
      ) : (
        <div className={styles.motionGrid}>
          {list.map((m) => (
            <Button
              key={m}
              size="sm"
              variant="secondary"
              data-testid={`motion-option-${m}`}
              onClick={() => {
                playMotionNow(m);
                close();
              }}
            >
              {t(ACTION_LABELS[m] ?? MOTION_LABELS[m] ?? m)}
            </Button>
          ))}
        </div>
      )}
    </Modal>
  );
};

export default MotionMenu;
