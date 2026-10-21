import type { LicenseTermsView } from '@nomi-ai/types';

/** 徽章文字：开源许可显示 SPDX；自定义条款去掉 LicenseRef- 前缀 */
export function licenseLabel(license: string): string {
  return license.replace(/^LicenseRef-/, '');
}

/** 条件摘要：商用 / 再分发 / 改编 / 署名 / 禁止事项 */
export function conditionsText(t?: LicenseTermsView): string | undefined {
  if (!t) return undefined;
  const c = t.conditions;
  const yes = (v: boolean | undefined, a: string, b: string) =>
    v === undefined ? null : v ? a : b;
  return [
    yes(c.commercialUse, '可商用', '禁止商用'),
    yes(c.redistribution, '可再分发', '禁止再分发'),
    yes(c.modification, '可改编', '禁止改编'),
    yes(c.credit, '需署名', '无需署名'),
    c.prohibited?.length ? `禁止：${c.prohibited.join('、')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
