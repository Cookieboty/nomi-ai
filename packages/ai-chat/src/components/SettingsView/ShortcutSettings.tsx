/**
 * 设置 → 快捷键：列出全部快捷键，点击「修改」后按下新组合键即可改绑；
 * 与其他快捷键或系统快捷键（复制 / 粘贴 / 退出…）冲突时给出提示。
 */
import { Button, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import {
  FIXED_SHORTCUTS,
  GLOBAL_SHORTCUTS,
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
import { SectionPage } from './SectionPage';

const SHORTCUT_TABS = [
  { id: 'app', label: '应用内快捷键' },
  { id: 'global', label: '全局快捷键' },
] as const;
type ShortcutTab = (typeof SHORTCUT_TABS)[number]['id'];

export const ShortcutSettings: React.FC = () => {
  const bindings = useShortcutBindings();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [tab, setTab] = useState<ShortcutTab>('app');
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
    <SectionPage
      testId="settings-shortcuts-page"
      tabsLabel="快捷键分区"
      tabs={SHORTCUT_TABS}
      value={tab}
      onChange={(x) => {
        setRecording(null);
        setTab(x);
      }}
    >
      {tab === 'global' ? (
        <section className={styles.block} data-testid="settings-shortcuts-global">
          <p className={styles.note}>{t('全局快捷键由系统注册，Nomi 不在前台时也能触发。')}</p>
          <table className={styles.shortcutTable}>
            <thead>
              <tr>
                <th scope="col">{t('快捷键')}</th>
                <th scope="col">{t('功能')}</th>
              </tr>
            </thead>
            <tbody>
              {GLOBAL_SHORTCUTS.map(([k, label]) => (
                <tr key={k}>
                  <td>
                    <kbd className={styles.kbd}>{formatCombo(k)}</kbd>
                  </td>
                  <td>{t(label)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <section className={styles.block} data-testid="settings-shortcuts">
          {Object.keys(conflicts).length > 0 && (
            <div
              className={styles.conflictBanner}
              role="alert"
              data-testid="shortcut-conflict-banner"
            >
              {t(
                '检测到快捷键冲突：{0}。在下方对应行点「修改」换一个组合键。',
                SHORTCUT_DEFS.filter((d) => conflicts[d.id])
                  .map((d) => `${t(d.label)}（${formatCombo(bindings[d.id])}）`)
                  .join('、'),
              )}
            </div>
          )}
          <p className={styles.note}>
            {t('点击「修改」后按下新的组合键（需包含 ⌘/Ctrl 或 Alt，或使用 F1–F12）；Esc 取消。')}
          </p>
          <table className={styles.shortcutTable}>
            <thead>
              <tr>
                <th scope="col">{t('功能')}</th>
                <th scope="col">{t('快捷键')}</th>
                <th scope="col" className={styles.shortcutActions}>
                  {t('操作')}
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
                        {rec ? t('请按下新的组合键…') : formatCombo(bindings[d.id])}
                      </kbd>
                      {rec && invalid && (
                        <div className={styles.warn} role="alert">
                          {t('需要包含 ⌘/Ctrl 或 Alt（或使用 F1–F12）')}
                        </div>
                      )}
                      {!rec && c && (
                        <div
                          className={styles.warn}
                          role="alert"
                          data-testid={`shortcut-conflict-${d.id}`}
                        >
                          {c.with.length > 0 &&
                            t('与「{0}」冲突，只有一个会生效', c.with.map(labelOf).join('、'))}
                          {c.with.length > 0 && c.reserved && ' · '}
                          {c.reserved && t('与系统快捷键「{0}」冲突', t(c.reserved))}
                        </div>
                      )}
                    </td>
                    <td className={styles.shortcutActions}>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`shortcut-edit-${d.id}`}
                        aria-label={t('修改「{0}」的快捷键', t(d.label))}
                        onClick={() => {
                          setInvalid(false);
                          setRecording(rec ? null : d.id);
                        }}
                      >
                        {rec ? t('取消') : t('修改')}
                      </Button>
                      {custom && !rec && (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`shortcut-reset-${d.id}`}
                          aria-label={t('恢复「{0}」的默认快捷键', t(d.label))}
                          onClick={() => setBinding(d.id, null)}
                        >
                          {t('恢复默认')}
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
                    <span className={styles.note}>{t('固定')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {anyCustom && (
            <Button size="sm" onClick={resetBindings} data-testid="shortcut-reset-all">
              {t('全部恢复默认')}
            </Button>
          )}
        </section>
      )}
    </SectionPage>
  );
};
