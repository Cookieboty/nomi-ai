import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ALLOW, checkCharacterLeak } from '../check-character-leak.mjs';
import { findCharacterLeaks } from '../lib/characterLeak.mjs';

// 角色名扫描（docs/design/core-host-decoupling.md §11.2）：规则与扫描范围
describe('findCharacterLeaks', () => {
  it.each([
    ['诺米提示语音', '诺米'],
    ['你好，我是 Nomi·诺米', '诺米'],
    ['你好，我是 Nomi', '我是 Nomi'],
    ["Hi, I'm Nomi~", "I'm Nomi"],
    ['You are Nomi, an AI companion', 'You are Nomi'],
    ['显示 Nomi', '显示 Nomi'],
    ['关闭 Nomi（可在设置中重新打开）', '关闭 Nomi'],
    ['Nomi 工具栏', 'Nomi 工具栏'],
    ['Show Nomi', 'Show Nomi'],
    ['Nomi toolbar', 'Nomi toolbar'],
    ["Nomi's bubble lets you know", "Nomi's bubble"],
    ['桌面上先出现 Nomi，点她的「AI 对话」', 'Nomi，点她'],
    ["artboard || 'Nomi-full'", 'Nomi-full'],
  ])('flags character use: %s', (text, hit) => {
    expect(findCharacterLeaks(text).join('|')).toContain(hit);
  });

  it.each([
    'Nomi 对话的模型',
    'Nomi 网关：上游中断',
    '退出 Nomi',
    'Quit Nomi',
    'Nomi v2.1 is now available',
    'Chat with Nomi or use a coding tool',
    'store.isNomi(cur)',
    'title: `Nomi · ${goal}`',
    '不显示 Nomi 的模型提示',
    'brand.appName',
    'nomi-ai/host-electron',
  ])('leaves product use alone: %s', (text) => {
    expect(findCharacterLeaks(text)).toEqual([]);
  });
});

describe('checkCharacterLeak', () => {
  let root = '';
  const put = (rel: string, text: string) => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('scans package sources and other packs; skips the official pack, brand, tests and dist', () => {
    root = mkdtempSync(join(tmpdir(), 'char-leak-'));
    put('packages/app/src/ok.ts', "export const title = 'Nomi 对话';\n");
    put('packages/app/src/bad.ts', "\nexport const hi = '你好，我是诺米';\n");
    put('packages/app/config/default.json', '{ "name": "Nomi·诺米" }\n');
    put('packages/app/tests/x.test.ts', 'expect(x).not.toMatch(/诺米/);\n');
    put('packages/app/src/y.test.ts', 'expect(x).not.toMatch(/诺米/);\n');
    put('packages/app/dist/index.js', "'诺米'\n");
    put('packages/types/src/brand.ts', "export const brand = { appName: 'Nomi' };\n");
    put('characters/nomi/persona.json', '{ "displayName": "诺米" }\n');
    put('characters/other/persona.json', '{ "systemPromptIdentity": "你是 Nomi" }\n');
    const { leaks } = checkCharacterLeak({ root, allow: [] });
    expect(leaks.map((l) => `${l.file}:${l.line}`).sort()).toEqual([
      'characters/other/persona.json:1',
      'packages/app/config/default.json:1',
      'packages/app/src/bad.ts:2',
    ]);
  });

  it('allow-list entries suppress a hit and must be used', () => {
    root = mkdtempSync(join(tmpdir(), 'char-leak-'));
    put('packages/app/src/a.ts', "'诺米'\n");
    const reason = 'test';
    const used = checkCharacterLeak({
      root,
      allow: [{ file: 'packages/app/src/a.ts', match: '诺米', reason }],
    });
    expect(used.leaks).toEqual([]);
    expect(used.unusedAllow).toEqual([]);
    const stale = checkCharacterLeak({
      root,
      allow: [{ file: 'packages/app/src/gone.ts', match: '诺米', reason }],
    });
    expect(stale.leaks).toHaveLength(1);
    expect(stale.unusedAllow).toHaveLength(1);
  });

  it('every allow-list entry gives a reason', () => {
    for (const a of ALLOW) expect(a.reason.trim().length).toBeGreaterThan(10);
  });

  it('the repository passes', () => {
    const { leaks, unusedAllow } = checkCharacterLeak({ root: join(__dirname, '../..') });
    expect(leaks).toEqual([]);
    expect(unusedAllow).toEqual([]);
  });
});
