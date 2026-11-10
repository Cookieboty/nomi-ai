/**
 * 自定义主题编辑器：填 4 个种子色（或一次粘贴一组），其余令牌由 @nomi-ai/ui 推导；
 * 可以浅色、深色各配一套（跟随系统切换）、逐个覆盖颜色、加背景图。
 * 在设置页右侧抽屉里打开（一栏：基本颜色 → 样例与对比度 → 背景图 → 进阶）。
 * 编辑时整个窗口实时预览正在编辑的那套（previewCustomTheme），取消即还原，保存后切到这个主题。
 * 草稿状态在 customThemeDraft.ts。
 */
import {
  Button,
  Icon,
  Input,
  Modal,
  SEED_KEYS,
  SegmentedControl,
  Switch,
  contrastReport,
  customThemeName,
  customThemePref,
  customThemeTokens,
  getLocale,
  isHexColor,
  parseHex,
  parsePalette,
  previewCustomTheme,
  setTheme,
  t as tr,
  toHex,
  type ContrastCheck,
  type CustomThemeDef,
  type SeedKey,
  type ThemeBase,
} from '@nomi-ai/ui';
import { AlertTriangle, Check } from 'lucide-react';
import React, { useEffect, useId, useMemo, useState } from 'react';

import { saveCustomTheme, themeErrorText } from '../../services/customThemes';

import {
  baseMismatch,
  currentVariant,
  draftProblems,
  draftToTheme,
  initDraft,
  setBackground,
  setDual,
  setEditing,
  setPalette,
  setSeed,
  setToken,
} from './customThemeDraft';
import styles from './CustomThemeEditor.module.css';
import { ThemeBackgroundField } from './ThemeBackgroundField';
import { ThemeTokenOverrides } from './ThemeTokenOverrides';

export interface CustomThemeEditorProps {
  /** 编辑已有主题；null = 新建 */
  initial: CustomThemeDef | null;
  /** 新建时的起点颜色（当前主题的色卡） */
  startSeeds: Record<SeedKey, string>;
  onClose: () => void;
  onSaved: (def: CustomThemeDef) => void;
}

/** 静态 key（check:i18n 只认字面量） */
const SEED_LABEL: Record<SeedKey, string> = {
  accent: 'ui.chat-settings.theme-seed-accent',
  background: 'ui.chat-settings.theme-seed-background',
  surface: 'ui.chat-settings.theme-seed-surface',
  text: 'ui.chat-settings.theme-seed-text',
};
const CHECK_LABEL: Record<ContrastCheck['id'], string> = {
  'text-bg': 'ui.chat-settings.theme-contrast-text-bg',
  'text-surface': 'ui.chat-settings.theme-contrast-text-surface',
  'muted-surface': 'ui.chat-settings.theme-contrast-muted-surface',
  'on-accent': 'ui.chat-settings.theme-contrast-on-accent',
  'link-surface': 'ui.chat-settings.theme-contrast-link-surface',
};
const BASE_LABEL: Record<ThemeBase, string> = {
  light: 'ui.chat-settings.theme-variant-light',
  dark: 'ui.chat-settings.theme-variant-dark',
};

const nameKey = () => (getLocale().startsWith('zh') ? 'zh' : 'en');

/** 取色器只认 #rrggbb；输入框里的半截值不动它 */
const pickerValue = (v: string) => (isHexColor(v) ? toHex(parseHex(v)!) : '#000000');

export const CustomThemeEditor: React.FC<CustomThemeEditorProps> = ({
  initial,
  startSeeds,
  onClose,
  onSaved,
}) => {
  const idPrefix = useId();
  const [name, setName] = useState(() =>
    initial ? customThemeName(initial, getLocale()) : tr('ui.chat-settings.my-themes'),
  );
  const [draft, setDraft] = useState(() => initDraft(initial, startSeeds));
  const [palette, setPaletteText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const theme = useMemo(
    () => draftToTheme(draft, initial?.id ?? 'preview', { [nameKey()]: name }),
    [draft, initial, name],
  );
  const editing = draft.editing;
  const variant = currentVariant(draft);

  // 实时预览正在编辑的那套；关掉编辑器（保存 / 取消 / 卸载）时还原
  useEffect(() => previewCustomTheme(theme, editing), [theme, editing]);
  useEffect(() => () => previewCustomTheme(null), []);

  const tokens = useMemo(() => customThemeTokens(theme, editing), [theme, editing]);
  const report = useMemo(() => contrastReport(theme, editing), [theme, editing]);
  const brand = tokens['--cd-color-brand']!;
  const accent = tokens['--cd-color-accent']!;

  const onPalette = (text: string) => {
    setPaletteText(text);
    const colors = parsePalette(text);
    if (colors.length) setDraft((d) => setPalette(d, colors));
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError(tr('ui.chat-settings.theme-name-required'));
    const problem = draftProblems(draft)[0];
    if (problem) {
      setDraft((d) => setEditing(d, problem.base));
      return setError(
        problem.kind === 'seed'
          ? tr('ui.chat-settings.theme-invalid-color')
          : tr('ui.chat-settings.theme-invalid-token', problem.key),
      );
    }
    setSaving(true);
    setError(null);
    try {
      const { id: _id, format: _format, name: _name, ...rest } = draftToTheme(draft, 'x', {});
      const saved = await saveCustomTheme({
        ...(initial ? { id: initial.id } : {}),
        ...rest,
        name: { ...(initial?.name ?? {}), [nameKey()]: trimmed },
        ...(initial?.author ? { author: initial.author } : {}),
      });
      await setTheme(customThemePref(saved.id));
      onSaved(saved);
    } catch (e) {
      setError(tr('ui.voice-mascot.save-failed', themeErrorText(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      closeOnOverlay={false}
      title={tr(initial ? 'ui.chat-settings.edit-theme' : 'ui.chat-settings.new-theme')}
      data-testid="custom-theme-editor"
      footer={
        <>
          <Button onClick={onClose}>{tr('ui.foundation.cancel')}</Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
            data-testid="custom-theme-save"
          >
            {tr('ui.foundation.save')}
          </Button>
        </>
      }
    >
      <div className={styles.layout}>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>{tr('ui.foundation.name')}</span>
            <Input
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              data-testid="custom-theme-name"
            />
          </label>

          <div className={styles.dualRow}>
            <div className={styles.dualText}>
              <span className={styles.label}>{tr('ui.chat-settings.theme-dual')}</span>
              <span className={styles.hint}>{tr('ui.chat-settings.theme-dual-hint')}</span>
            </div>
            <Switch
              checked={draft.dual}
              onChange={(on) => setDraft((d) => setDual(d, on))}
              aria-label={tr('ui.chat-settings.theme-dual')}
              data-testid="custom-theme-dual"
            />
          </div>
          {draft.dual && (
            <SegmentedControl<ThemeBase>
              options={(['light', 'dark'] as const).map((b) => ({
                value: b,
                label: tr(BASE_LABEL[b]),
                testId: `custom-theme-variant-${b}`,
              }))}
              value={editing}
              onChange={(b) => setDraft((d) => setEditing(d, b))}
              aria-label={tr('ui.chat-settings.theme-dual')}
            />
          )}

          <label className={styles.field}>
            <span className={styles.label}>{tr('ui.chat-settings.theme-paste-palette')}</span>
            <Input
              value={palette}
              placeholder="#4fa3d9 #0f1a22 #172632 #e6f0f5"
              onChange={(e) => onPalette(e.target.value)}
              data-testid="custom-theme-palette"
            />
            <span className={styles.hint}>{tr('ui.chat-settings.theme-paste-palette-hint')}</span>
          </label>
          {SEED_KEYS.map((k) => {
            const id = `${idPrefix}-${k}`;
            const value = variant.seeds[k];
            return (
              <div key={k} className={styles.seedRow}>
                <label htmlFor={id} className={styles.seedLabel}>
                  {tr(SEED_LABEL[k])}
                </label>
                <input
                  type="color"
                  className={styles.picker}
                  value={pickerValue(value)}
                  onChange={(e) => setDraft((d) => setSeed(d, k, e.target.value))}
                  aria-label={tr(SEED_LABEL[k])}
                  data-testid={`custom-theme-picker-${k}`}
                />
                <Input
                  id={id}
                  size="sm"
                  className={styles.hex}
                  value={value}
                  invalid={!isHexColor(value)}
                  spellCheck={false}
                  maxLength={7}
                  onChange={(e) => setDraft((d) => setSeed(d, k, e.target.value))}
                  data-testid={`custom-theme-seed-${k}`}
                />
              </div>
            );
          })}
          <p className={styles.hint}>
            {draft.dual
              ? baseMismatch(draft)
                ? tr(
                    editing === 'dark'
                      ? 'ui.chat-settings.theme-variant-mismatch-dark'
                      : 'ui.chat-settings.theme-variant-mismatch-light',
                  )
                : null
              : tr(
                  editing === 'dark'
                    ? 'ui.chat-settings.theme-base-dark'
                    : 'ui.chat-settings.theme-base-light',
                )}
          </p>
        </div>

        <div className={styles.preview}>
          <div className={styles.sample} aria-hidden>
            <div className={styles.sampleRow}>
              <Button size="sm" variant="primary" tabIndex={-1}>
                {tr('ui.chat-settings.theme-sample-primary')}
              </Button>
              <Button size="sm" tabIndex={-1}>
                {tr('ui.chat-settings.theme-sample-secondary')}
              </Button>
            </div>
            <span className={styles.sampleLink}>{tr('ui.chat-settings.theme-sample-link')}</span>
            <span className={styles.sampleMuted}>{tr('ui.chat-settings.theme-sample-muted')}</span>
          </div>

          <div className={styles.contrast} data-testid="custom-theme-contrast">
            <span className={styles.label}>{tr('ui.chat-settings.theme-contrast')}</span>
            <ul className={styles.checks}>
              {report.map((c) => (
                <li key={c.id} className={c.ok ? styles.ok : styles.low} data-ok={c.ok}>
                  <Icon icon={c.ok ? Check : AlertTriangle} size={14} />
                  <span className={styles.checkName}>{tr(CHECK_LABEL[c.id])}</span>
                  <span className={styles.ratio}>{c.ratio.toFixed(1)}:1</span>
                  {!c.ok && (
                    <span className={styles.lowNote}>
                      {tr('ui.chat-settings.theme-contrast-low', String(c.min))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {accent !== brand && (
              <p className={styles.hint} data-testid="custom-theme-accent-adjusted">
                {tr('ui.chat-settings.theme-accent-adjusted', accent, brand)}
              </p>
            )}
          </div>
        </div>
        <p className={styles.hint}>{tr('ui.chat-settings.theme-preview-note')}</p>

        <ThemeBackgroundField
          value={draft.background}
          onChange={(bg) => setDraft((d) => setBackground(d, bg))}
        />

        <ThemeTokenOverrides
          overrides={variant.tokens}
          derived={tokens}
          onChange={(token, value) => setDraft((d) => setToken(d, token, value))}
        />
      </div>
      {error && (
        <div className={styles.error} role="alert" data-testid="custom-theme-error">
          {error}
        </div>
      )}
    </Modal>
  );
};
