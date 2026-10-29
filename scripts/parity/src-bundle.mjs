// 从 TS 源码装载模块（不依赖各包未构建的 dist）：esbuild 打成单个 ESM，@nomi-ai/* 改指向 packages/<pkg>/src。
// 第三方包按各自导入方目录解析后一并打进去（pnpm 严格依赖下也能找到）；node 内建保持外部。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function srcOf(root, spec) {
  const m = /^@nomi-ai\/([^/]+)(\/.*)?$/.exec(spec);
  const dir = path.join(root, 'packages', m[1]);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const sub = m[2] ? `.${m[2]}` : '.';
  const ex = pj.exports?.[sub];
  const t = typeof ex === 'string' ? ex : ex?.types ?? ex?.import ?? ex?.default;
  const cands = [];
  if (t) cands.push(t.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$|\.c?js$|\.mjs$/, '.ts'));
  cands.push(sub === '.' ? './src/index.ts' : `./src${m[2]}.ts`, sub === '.' ? './src/index.tsx' : `./src${m[2]}/index.ts`);
  for (const c of cands) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
    if (fs.existsSync(p + 'x')) return p + 'x';
  }
  throw new Error(`src-bundle: no TS source for ${spec}`);
}

/** entries: { name: absolute TS path }；返回 { name: 模块命名空间 }（共享同一份模块实例） */
export async function importSources(root, entries) {
  const { build } = await import('esbuild');
  const names = Object.keys(entries);
  const entry = names.map((n, i) => `export * as m${i} from ${JSON.stringify(entries[n])};`).join('\n');
  const r = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'js' },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false, logLevel: 'error',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    plugins: [{ name: 'nomi-src', setup(b) { b.onResolve({ filter: /^@nomi-ai\// }, (a) => ({ path: srcOf(root, a.path) })); } }],
  });
  const dir = path.join(root, 'node_modules', '.cache', 'parity-src');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `b-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(f, r.outputFiles[0].text);
  try {
    const ns = await import(pathToFileURL(f).href);
    return Object.fromEntries(names.map((n, i) => [n, ns[`m${i}`]]));
  } finally {
    fs.rmSync(f, { force: true });
  }
}
