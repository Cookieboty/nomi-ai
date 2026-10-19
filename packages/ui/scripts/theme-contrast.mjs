#!/usr/bin/env node
/**
 * 主题对比度报告：node scripts/theme-contrast.mjs [--json] [--css <file>] [--legacy] [--only-fail]
 *  --legacy  对没有新令牌的旧 tokens.css 做对照（新令牌退回旧 CSS 实际使用的令牌）
 * 有任何配对低于阈值时以退出码 1 结束。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateAll, LEGACY_ALIASES, readThemes, THEME_IDS } from './theme-contrast-lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const ci = args.indexOf('--css');
const css =
  ci >= 0
    ? args[ci + 1]
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/tokens.css');
const res = evaluateAll(readThemes(css), { aliases: flag('--legacy') ? LEGACY_ALIASES : {} });

if (flag('--json')) {
  console.info(JSON.stringify(res, null, 1));
} else {
  for (const id of THEME_IDS) {
    console.info(`\n== ${id} ==`);
    for (const r of res[id]) {
      if (flag('--only-fail') && r.pass) continue;
      console.info(
        `${r.pass ? 'ok  ' : 'FAIL'} ${r.ratio.toFixed(2).padStart(5)} (min ${r.min})  ${r.fg} on ${r.bg}  ${r.label}`,
      );
    }
  }
}
const failed = THEME_IDS.reduce((n, id) => n + res[id].filter((r) => !r.pass).length, 0);
(flag('--json') ? console.error : console.info)(`\n${failed} pair(s) below threshold`);
process.exit(failed ? 1 : 0);
