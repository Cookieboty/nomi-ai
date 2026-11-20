// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildUi, replaceDirAtomically } from '../scripts/build.mjs';

function setupFixture(dir: string) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        outDir: 'dist',
        rootDir: 'src',
        declaration: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        target: 'ES2020',
        strict: true,
        skipLibCheck: true,
      },
      include: ['src/**/*'],
    }),
  );
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const version: number = 1;\n');
  writeFileSync(join(dir, 'src', 'styles.css'), '.btn { color: red; }\n');
  writeFileSync(join(dir, 'src', 'tokens.css'), ':root { --t: 1px; }\n');
}

describe('@nomi-ai/ui atomic build', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('preserves previous dist artifacts when TypeScript fails, then replaces atomically on recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-atomic-build-'));
    dirs.push(root);
    setupFixture(root);

    // 步骤 1：首次成功构建
    expect(await buildUi({ root })).toBe(true);
    const v1Js = readFileSync(join(root, 'dist', 'index.js'), 'utf8');
    const v1Dts = readFileSync(join(root, 'dist', 'index.d.ts'), 'utf8');
    const v1Styles = readFileSync(join(root, 'dist', 'styles.css'), 'utf8');
    const v1Tokens = readFileSync(join(root, 'dist', 'tokens.css'), 'utf8');
    expect(v1Js).toContain('version = 1');
    expect(v1Dts).toContain('export declare const version: number');
    expect(v1Styles).toContain('color: red');
    expect(v1Tokens).toContain('--t: 1px');
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);

    // 步骤 2：TypeScript 检查失败 + 修改 CSS，上一次可用产物不得被删除或覆盖
    writeFileSync(join(root, 'src', 'index.ts'), 'export const version: number = "broken";\n');
    writeFileSync(join(root, 'src', 'styles.css'), '.btn { color: green; }\n');

    expect(await buildUi({ root })).toBe(false);
    expect(readFileSync(join(root, 'dist', 'index.js'), 'utf8')).toBe(v1Js);
    expect(readFileSync(join(root, 'dist', 'index.d.ts'), 'utf8')).toBe(v1Dts);
    expect(readFileSync(join(root, 'dist', 'styles.css'), 'utf8')).toBe(v1Styles);
    expect(readFileSync(join(root, 'dist', 'tokens.css'), 'utf8')).toBe(v1Tokens);
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);

    // 步骤 3：修复错误后恢复成功，dist 原子更新为最新版本
    writeFileSync(
      join(root, 'src', 'index.ts'),
      'export const version: number = 2;\nexport const extra = "ok";\n',
    );
    expect(await buildUi({ root })).toBe(true);
    expect(readFileSync(join(root, 'dist', 'index.js'), 'utf8')).toContain('version = 2');
    expect(readFileSync(join(root, 'dist', 'index.d.ts'), 'utf8')).toContain('extra');
    expect(readFileSync(join(root, 'dist', 'styles.css'), 'utf8')).toContain('color: green');
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);
  }, 30000);

  it('rolls back backup dist when staging rename fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-atomic-rollback-'));
    dirs.push(root);
    const distDir = join(root, 'dist');
    const stagingDir = join(root, '.tmp', 'staging');
    const backupDir = join(root, '.tmp', 'backup');

    mkdirSync(distDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(distDir, 'index.js'), 'old');
    writeFileSync(join(stagingDir, 'index.js'), 'new');

    let calls = 0;
    await expect(
      replaceDirAtomically({
        stagingDir,
        distDir,
        backupDir,
        renameFn: (from, to) => {
          calls += 1;
          // 第一次把 dist -> backup 成功，第二次把 staging -> dist 失败，第三次把 backup -> dist 回滚
          if (calls === 2) {
            throw new Error('simulated rename failure');
          }
          renameSync(from, to);
        },
      }),
    ).rejects.toThrow('simulated rename failure');

    expect(existsSync(distDir)).toBe(true);
    expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toBe('old');
    expect(existsSync(backupDir)).toBe(false);
  });
});
