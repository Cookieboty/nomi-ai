/**
 * 依赖边界（docs/design/core-host-decoupling.md §3.2、§10.6、§11.1）：avatar-runtime 只依赖
 * character-contract 与浏览器 API。eslint 拦源码里的 import（eslint.config.mjs），这里再拦 package.json
 * 与动态写法（require / import()）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '..');
const FORBIDDEN = [
  /^electron$/,
  /^@nomi-ai\/contract(\/|$)/,
  /^@nomi-ai\/ai-sdk(-client)?(\/|$)/,
  /^@nomi-ai\/host-/,
  /^@nomi-ai\/core(\/|$)/,
  /^@nomi-ai\/(renderer|ai-chat|electron)(\/|$)/,
  /^@nomi-ai\/ui(\/|$)/,
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}

describe('avatar-runtime dependency boundary', () => {
  it('package.json lists no contract / electron / ai-sdk-client / view / ui dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(deps.filter((d) => FORBIDDEN.some((re) => re.test(d)))).toEqual([]);
  });

  it('source never loads them, statically or dynamically, nor touches host globals', () => {
    const bad: string[] = [];
    for (const file of walk(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      const specs = [
        ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
        ...text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((m) => m[1]);
      for (const s of specs) {
        if (FORBIDDEN.some((re) => re.test(s)) || /services\/api|renderer\/src/.test(s))
          bad.push(`${path.relative(ROOT, file)}: ${s}`);
      }
      if (/\b(nomiTransport|nomiHost|aiIPC|electronAPI)\b/.test(text))
        bad.push(`${path.relative(ROOT, file)}: host global`);
    }
    expect(bad).toEqual([]);
  });
});
