/**
 * AI 与角色之间只传语义事件（docs/design/core-host-decoupling.md §10.5、§12 C3 的完成标准）：
 * AI 侧代码（内核、AI 运行时、AI SDK、插件包、契约）里不出现角色包的片段 / 动作 / 表情资源名，
 * 只用 `@nomi-ai/character-contract` 词表里的语义名；资源名只在角色包的 mapping.json 与引擎
 * （avatar-runtime）里。
 *
 * 资源名取自契约数据（Rive 原生片段、2D 骨架动作）加上引擎控制名，去掉与语义名同名的，再去掉
 * 太常见、会误报的英文词（ok / run / step …）。注释里的举例不算。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

const AI_SIDE = [
  'packages/core/src',
  'packages/ai-runtime/src',
  'packages/ai-sdk/src',
  'packages/ai-sdk-client/src',
  'packages/bundle-ig-base/src',
  'packages/bundle-ig-mascot/src',
  'packages/bundle-ig-electron-caps/src',
  'packages/contract/src',
];

/** 常见英文词：作为资源名不够有辨识度，在业务代码里另有含义 */
const GENERIC = new Set(['ok', 'run', 'step', 'walk', 'blink', 'fist', 'typing', 'poke', 'squat']);

interface ContractJson {
  rive: { nativeMotions: string[] };
  sprite: { actionIds: string[] };
  mapping: { emotions: string[]; activities: string[]; gestures: string[] };
}

function resourceNames(): string[] {
  const c = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'packages/character-contract/contract.json'), 'utf8'),
  ) as ContractJson;
  const semantic = new Set([...c.mapping.emotions, ...c.mapping.activities, ...c.mapping.gestures]);
  const engine = ['think-on', 'think-off', 'shake', 'flinch', 'interact', 'hello', 'sorry'];
  return [...new Set([...c.rive.nativeMotions, ...c.sprite.actionIds, ...engine])].filter(
    (n) => !semantic.has(n) && !GENERIC.has(n),
  );
}

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
}

describe('AI side speaks semantic avatar names only', () => {
  const names = resourceNames();

  it('knows the resource names it guards against', () => {
    expect(names).toEqual(expect.arrayContaining(['thumbs_up', 'shake_head', 'think-on', 'sorry']));
    expect(names).not.toContain('wave'); // 同名的语义手势不算资源名
  });

  it.each(AI_SIDE)('%s has no clip / motion / expression resource names', (dir) => {
    const hits: string[] = [];
    const quoted = new RegExp(
      `['"\`](${names.map((n) => n.replace(/-/g, '\\-')).join('|')})['"\`]`,
    );
    for (const file of walk(path.join(ROOT, dir))) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
          const m = quoted.exec(line);
          if (m) hits.push(`${path.relative(ROOT, file)}:${i + 1} ${m[1]}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
