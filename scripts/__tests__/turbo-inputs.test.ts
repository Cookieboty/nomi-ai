import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

// 回归 #22：自定义 inputs 会替换 turbo 默认文件集；漏掉 index.html / public / scripts/*.mjs /
// jest.config.js 会让缓存（含 CI restore-keys 恢复的跨提交缓存）重放旧产物。
const turbo = JSON.parse(readFileSync(join(__dirname, '../../turbo.json'), 'utf8')) as {
  globalDependencies: string[];
  tasks: Record<string, { inputs?: string[] }>;
};

describe('turbo.json inputs', () => {
  it.each(['build', 'typecheck', 'lint', 'test'])('%s 保留默认文件集', (task) => {
    expect(turbo.tasks[task].inputs).toContain('$TURBO_DEFAULT$');
  });

  it('依赖外部文件的 vite 包把它们显式列入 build 输入', () => {
    for (const t of ['@nomi-ai/renderer#build', '@nomi-ai/ai-chat#build']) {
      const inputs = turbo.tasks[t].inputs ?? [];
      expect(inputs).toContain('$TURBO_DEFAULT$');
      expect(inputs).toContain('$TURBO_ROOT$/scripts/ports.mjs');
      expect(inputs).toContain('$TURBO_ROOT$/packages/host-electron/src/security/csp.ts');
    }
  });

  // pnpm build 之后 host-electron 的 dist 要能直接跑（e2e-headed、`electron .`）：两个视图先构建，
  // host-electron 的 build 最后把它们复制进 dist/renderer 与 dist/ai-chat
  it('host-electron 的 build 依赖两个视图并复制它们', () => {
    const t = turbo.tasks['@nomi-ai/host-electron#build'] as { dependsOn?: string[] };
    expect(t.dependsOn).toEqual(
      expect.arrayContaining(['^build', '@nomi-ai/renderer#build', '@nomi-ai/ai-chat#build']),
    );
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../packages/host-electron/package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toMatch(/copy-renderer\.js$/);
  });

  it('根 run-bin 脚本参与所有任务的 hash', () => {
    expect(turbo.globalDependencies).toContain('scripts/run-bin.mjs');
  });

  // 包里的源码 / 测试用相对路径引用别的包或仓库根的文件时，turbo 不会自动把它算进这个包的 hash：
  // 只改那个文件，测试会命中旧缓存。每个这样的文件都必须显式列进该包 test 任务的 inputs。
  it('跨包的相对引用都列进了对应包 test 任务的 inputs', () => {
    const root = join(__dirname, '../..');
    const missing: string[] = [];
    const walk = (dir: string, out: string[] = []): string[] => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return out;
      }
      for (const n of names) {
        if (n === 'node_modules' || n === 'dist') continue;
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.m?[jt]sx?$/.test(n)) out.push(p);
      }
      return out;
    };
    type Pkg = { name: string; dependencies?: object; devDependencies?: object };
    const pkgs = new Map<string, { dir: string; json: Pkg }>();
    for (const pkgDir of readdirSync(join(root, 'packages'))) {
      const dir = join(root, 'packages', pkgDir);
      try {
        const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Pkg;
        pkgs.set(json.name, { dir, json });
      } catch {
        /* 不是包 */
      }
    }
    for (const [name, { dir: base, json }] of pkgs) {
      // 声明过的工作区依赖：test 依赖 ^build，依赖包的源码已经经由它的 build hash 算进来
      const depDirs = Object.keys({ ...json.dependencies, ...json.devDependencies })
        .map((d) => pkgs.get(d)?.dir)
        .filter((d): d is string => !!d);
      const inputs = turbo.tasks[`${name}#test`]?.inputs ?? [];
      for (const f of [...walk(join(base, 'src')), ...walk(join(base, 'tests'))]) {
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(/(?:from|import\(|require\()\s*['"](\.[^'"]+)['"]/g)) {
          const target = normalize(join(dirname(f), m[1]!));
          if (target.startsWith(base + sep)) continue;
          if (depDirs.some((d) => target.startsWith(d + sep))) continue;
          const rel = relative(root, target).split(sep).join('/');
          const ok = inputs.some(
            (i) =>
              i.startsWith('$TURBO_ROOT$/') &&
              i.slice(13).replace(/\.[^./]+$/, '') === rel.replace(/\.[^./]+$/, ''),
          );
          if (!ok) missing.push(`${name}: ${relative(root, f)} -> ${rel}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
