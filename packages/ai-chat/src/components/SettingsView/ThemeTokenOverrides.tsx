/**
 * 自定义主题编辑器 · 进阶：逐个覆盖推导出的颜色（只列 THEMEABLE_TOKENS）。
 * 空 = 用推导值（输入框占位显示推导值）；取值支持 hex / rgb() / hsl() / oklch()。
 */
import {
  Disclosure,
  IconButton,
  Icon,
  Input,
  THEMEABLE_TOKENS,
  isHexColor,
  isSafeColorValue,
  parseHex,
  t as tr,
  toHex,
} from '@nomi-ai/ui';
import { RotateCcw } from 'lucide-react';
import React from 'react';

import styles from './CustomThemeEditor.module.css';

/** 分组（按顺序取第一个匹配的） */
const GROUPS: { label: string; test: RegExp }[] = [
  { label: 'ui.chat-settings.theme-group-accent', test: /accent|brand|border-focus/ },
  { label: 'ui.chat-settings.theme-group-status', test: /success|warning|danger|info|neutral/ },
  { label: 'ui.chat-settings.theme-group-controls', test: /btn-secondary|disabled|switch/ },
  { label: 'ui.chat-settings.theme-group-bubble', test: /^--cd-bubble-/ },
  { label: 'ui.chat-settings.theme-group-border', test: /^--cd-color-border/ },
  {
    label: 'ui.chat-settings.theme-group-surface',
    test: /^--cd-color-(bg|surface|hover|active|selected-bg|user-msg|input-bg|overlay)/,
  },
  { label: 'ui.chat-settings.theme-group-text', test: /^--cd-color-(text|selected-text)/ },
];

export const TOKEN_GROUPS: { label: string; tokens: string[] }[] = (() => {
  const out = GROUPS.map((g) => ({ label: g.label, tokens: [] as string[] }));
  for (const token of THEMEABLE_TOKENS) {
    const i = GROUPS.findIndex((g) => g.test.test(token));
    out[i < 0 ? out.length - 1 : i]!.tokens.push(token);
  }
  return out.filter((g) => g.tokens.length);
})();

const shortName = (token: string) => token.replace(/^--cd-(color-)?/, '');

/** 取色器只认 #rrggbb：覆盖值是 hex 用它，否则用推导值（推导值是 rgba 时退回黑色） */
const pickerValue = (override: string | undefined, derived: string | undefined) => {
  const v = override && isHexColor(override) ? override : derived;
  return v && isHexColor(v) ? toHex(parseHex(v)!) : '#000000';
};

export interface ThemeTokenOverridesProps {
  overrides: Record<string, string>;
  derived: Record<string, string>;
  onChange: (token: string, value: string) => void;
}

export const ThemeTokenOverrides: React.FC<ThemeTokenOverridesProps> = ({
  overrides,
  derived,
  onChange,
}) => {
  const count = Object.keys(overrides).length;
  return (
    <Disclosure
      summary={
        count
          ? tr('ui.chat-settings.theme-advanced-count', String(count))
          : tr('ui.chat-settings.theme-advanced')
      }
      data-testid="custom-theme-advanced"
    >
      <p className={styles.hint}>{tr('ui.chat-settings.theme-advanced-hint')}</p>
      {TOKEN_GROUPS.map((g) => (
        <div key={g.label} className={styles.tokenGroup}>
          <span className={styles.label}>{tr(g.label)}</span>
          {g.tokens.map((token) => {
            const value = overrides[token] ?? '';
            const bad = !!value && !isSafeColorValue(value);
            return (
              <div key={token} className={styles.tokenRow}>
                <code className={styles.tokenName} title={token}>
                  {shortName(token)}
                </code>
                <input
                  type="color"
                  className={styles.picker}
                  value={pickerValue(value, derived[token])}
                  onChange={(e) => onChange(token, e.target.value)}
                  aria-label={token}
                />
                <Input
                  size="sm"
                  className={styles.hex}
                  value={value}
                  placeholder={derived[token] ?? ''}
                  invalid={bad}
                  spellCheck={false}
                  maxLength={64}
                  aria-label={token}
                  onChange={(e) => onChange(token, e.target.value)}
                  data-testid={`custom-theme-token-${shortName(token)}`}
                />
                <IconButton
                  size="sm"
                  label={tr('ui.chat-settings.theme-token-reset')}
                  icon={<Icon icon={RotateCcw} size={14} />}
                  disabled={!value}
                  onClick={() => onChange(token, '')}
                />
              </div>
            );
          })}
        </div>
      ))}
    </Disclosure>
  );
};
