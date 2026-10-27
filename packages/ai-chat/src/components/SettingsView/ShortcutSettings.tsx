/**
 * 设置 → 快捷键：列出全部快捷键，点击「修改」后按下新组合键即可改绑；
 * 与其他快捷键或系统快捷键（复制 / 粘贴 / 退出…）冲突时给出提示。
 */
import { Button, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import {
  FIXED_SHORTCUTS,
  SHORTCUT_DEFS,
  comboFromEvent,
  findConflicts,
  formatCombo,
  isValidCombo,
  resetBindings,
  setBinding,
  useShortcutBindings,
  type ShortcutId,
} from '../../services/shortcuts';

import styles from './index.module.css';

export const ShortcutSettings: React.FC = () => {
  const bindings = useShortcutBindings();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [invalid, setInvalid] = useState(false);
  const conflicts = findConflicts(bindings);
  const labelOf = (id: ShortcutId) => t(SHORTCUT_DEFS.find((d) => d.id === id)!.label);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        setInvalid(false);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // 只按了修饰键，继续等
      if (!isValidCombo(combo)) {
        setInvalid(true);
        return;
      }
      setBinding(recording, combo);
      setRecording(null);
      setInvalid(false);
    };
    // 捕获阶段：抢在全局快捷键之前
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  const anyCustom = SHORTCUT_DEFS.some((d) => bindings[d.id] !== d.combo);

  return (
    <section className={styles.block} data-testid="settings-shortcuts">
      {Object.keys(conflicts).length > 0 && (
        <div className={styles.conflictBanner} role="alert" data-testid="shortcut-conflict-banner">
          {t(
            'ui.chat-settings.shortcut-conflict-detected-click-edit-on-that-row',
            SHORTCUT_DEFS.filter((d) => conflicts[d.id])
              .map((d) => `${t(d.label)}（${formatCombo(bindings[d.id])}）`)
              .join('、'),
          )}
        </div>
      )}
      <p className={styles.note}>
        {t('ui.mascot-theme.click-change-then-press-the-new-key-combination')}
      </p>
      <table className={styles.shortcutTable}>
        <thead>
          <tr>
            <th scope="col">{t('ui.chat-settings.action')}</th>
            <th scope="col">{t('ui.chat-settings.shortcuts')}</th>
            <th scope="col" className={styles.shortcutActions}>
              {t('ui.foundation.action')}
            </th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUT_DEFS.map((d) => {
            const c = conflicts[d.id];
            const rec = recording === d.id;
            const custom = bindings[d.id] !== d.combo;
            return (
              <tr key={d.id} data-testid={`shortcut-row-${d.id}`}>
                <th scope="row">{t(d.label)}</th>
                <td>
                  <kbd
                    className={styles.kbd}
                    data-testid={`shortcut-combo-${d.id}`}
                    data-shortcut-recording={rec ? 'true' : undefined}
                  >
                    {rec
                      ? t('ui.mascot-theme.press-the-new-key-combination')
                      : formatCombo(bindings[d.id])}
                  </kbd>
                  {rec && invalid && (
                    <div className={styles.warn} role="alert">
                      {t('ui.mascot-theme.must-include-ctrl-or-alt-or-use-f1')}
                    </div>
                  )}
                  {!rec && c && (
                    <div
                      className={styles.warn}
                      role="alert"
                      data-testid={`shortcut-conflict-${d.id}`}
                    >
                      {c.with.length > 0 &&
                        t(
                          'ui.mascot-theme.conflicts-with-only-one-will-work',
                          c.with.map(labelOf).join('、'),
                        )}
                      {c.with.length > 0 && c.reserved && ' · '}
                      {c.reserved &&
                        t('ui.mascot-theme.conflicts-with-the-system-shortcut', t(c.reserved))}
                    </div>
                  )}
                </td>
                <td className={styles.shortcutActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`shortcut-edit-${d.id}`}
                    aria-label={t('ui.mascot-theme.change-the-shortcut-for', t(d.label))}
                    onClick={() => {
                      setInvalid(false);
                      setRecording(rec ? null : d.id);
                    }}
                  >
                    {rec ? t('ui.foundation.cancel') : t('ui.mascot-theme.change')}
                  </Button>
                  {custom && !rec && (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`shortcut-reset-${d.id}`}
                      aria-label={t('ui.mascot-theme.restore-the-default-shortcut-for', t(d.label))}
                      onClick={() => setBinding(d.id, null)}
                    >
                      {t('ui.providers-schedule.restore-defaults')}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
          {FIXED_SHORTCUTS.map(([k, label]) => (
            <tr key={k}>
              <th scope="row">{t(label)}</th>
              <td>
                <kbd className={styles.kbd}>{t(k)}</kbd>
              </td>
              <td className={styles.shortcutActions}>
                <span className={styles.note}>{t('ui.knowledge-local.pin')}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anyCustom && (
        <Button size="sm" onClick={resetBindings} data-testid="shortcut-reset-all">
          {t('ui.mascot-theme.restore-all-defaults')}
        </Button>
      )}
    </section>
  );
};
