import type { LicenseTermsView } from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';

/** 徽章文字：开源许可显示 SPDX；自定义条款去掉 LicenseRef- 前缀 */
export function licenseLabel(license: string): string {
  return license.replace(/^LicenseRef-/, '');
}

/** 条件摘要：商用 / 再分发 / 改编 / 署名 / 禁止事项（用户可见 UI，走 i18n） */
export function conditionsText(terms?: LicenseTermsView): string | undefined {
  if (!terms) return undefined;
  const c = terms.conditions;
  const yes = (v: boolean | undefined, a: string, b: string) =>
    v === undefined ? null : v ? t(a) : t(b);
  return [
    yes(
      c.commercialUse,
      'ui.mascot-theme.commercial-use-allowed',
      'ui.mascot-theme.commercial-use-forbidden',
    ),
    yes(
      c.redistribution,
      'ui.mascot-theme.redistribution-allowed',
      'ui.mascot-theme.redistribution-forbidden',
    ),
    yes(
      c.modification,
      'ui.mascot-theme.modification-allowed',
      'ui.mascot-theme.modification-forbidden',
    ),
    yes(c.credit, 'ui.mascot-theme.credit-required', 'ui.mascot-theme.credit-not-required'),
    c.prohibited?.length ? t('ui.mascot-theme.prohibited-list', c.prohibited.join(', ')) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
