/** 主进程侧的金额 / Token 文案格式（与渲染进程 UsagePanel/format.ts 同口径）。 */
import type { Currency } from './types';

export const currencySymbol = (c: Currency): string => (c === 'CNY' ? '¥' : '$');

/** USD → 当前币种金额 */
export const convertUsd = (usd: number, c: Currency, cnyPerUsd: number): number =>
  c === 'CNY' ? usd * cnyPerUsd : usd;

/** 金额展示：<0.01 显示 <$0.01；<1 保留 3 位；其余 2 位 */
export function formatMoney(usd: number, c: Currency, cnyPerUsd: number): string {
  const v = convertUsd(usd, c, cnyPerUsd);
  const s = currencySymbol(c);
  if (v === 0) return `${s}0.00`;
  if (v < 0.01) return `<${s}0.01`;
  if (v < 1) return `${s}${v.toFixed(3)}`;
  if (v < 1000) return `${s}${v.toFixed(2)}`;
  return `${s}${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** 已经是当前币种的金额（预算 / 阈值） */
export function formatAmount(v: number, c: Currency): string {
  const s = currencySymbol(c);
  return `${s}${v >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.00$/, '')}`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (let i = 0; i < units.length; i++) {
    const [base, unit] = units[i]!;
    if (n < base) continue;
    let v = n / base;
    let u = unit;
    // 四舍五入后凑满 1000 就进位
    if (Math.round(v) >= 1000 && i > 0) {
      v = n / units[i - 1]![0];
      u = units[i - 1]![1];
    }
    const txt = v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
    return `${txt.includes('.') ? txt.replace(/\.?0+$/, '') : txt}${u}`;
  }
  return String(Math.round(n));
}
