import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SETTINGS_ICONS } from '../src/components/AppIcons';
import { SETTINGS_SECTIONS } from '../src/components/SettingsView/sections';

const SRC = path.resolve(__dirname, '../src');
const UI_SRC = path.resolve(__dirname, '../../ui/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

// 图形 emoji（含 ⚠ ⚙ ✂ ✦ 等符号型）；不含 → × · … 等普通排版符号
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}]/u;

describe('图标规范：界面里不用 emoji 当图标', () => {
  it('ai-chat / ui 的 tsx 里没有 emoji / 符号字形图标（注释与模板字符串里的消息文本除外）', () => {
    const offenders: string[] = [];
    for (const f of [...walk(SRC), ...walk(UI_SRC)]) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (EMOJI.test(line)) offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('设置左侧导航图标', () => {
  it('11 个分区各有一个 lucide 图标，且互不重复', () => {
    expect(SETTINGS_SECTIONS).toHaveLength(11);
    const icons = SETTINGS_SECTIONS.map((s) => s.icon);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
    expect(Object.keys(SETTINGS_ICONS)).toHaveLength(11);
  });
});
