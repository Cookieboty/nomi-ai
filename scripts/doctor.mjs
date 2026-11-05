#!/usr/bin/env node
// 开发环境预检：`pnpm doctor`（完整）或 `pnpm dev` 前自动跑的快速版（--quick）。
// 只用 Node 内建模块，Node 版本过低时也能给出清楚的提示。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './ports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const MIN_NODE = [22, 12, 0];
let failed = false;
const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => console.log(`  ⚠ ${m}`);
const bad = (m, fix) => {
  failed = true;
  console.log(`  ✖ ${m}${fix ? `\n      → ${fix}` : ''}`);
};

console.log(quick ? 'Preflight' : 'Nomi doctor');

// 1. Node
const v = process.versions.node.split('.').map(Number);
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
if (newer(v, MIN_NODE) < 0)
  bad(
    `Node ${process.versions.node} is too old (need >= ${MIN_NODE.join('.')}).`,
    'Install Node 22 LTS or newer (e.g. `nvm install` uses .nvmrc, or `brew install node@22`), then reinstall: rm -rf node_modules && pnpm install',
  );
else ok(`Node ${process.versions.node} (${process.platform}/${process.arch})`);

// 2. pnpm
const ua = process.env.npm_config_user_agent ?? '';
const pnpmV = /pnpm\/(\d+)/.exec(ua)?.[1];
if (ua && !pnpmV)
  bad(`run through pnpm, not ${ua.split(' ')[0]}`, 'corepack enable && pnpm install');
else if (pnpmV && Number(pnpmV) < 9)
  bad(
    `pnpm ${pnpmV} is too old (need >= 9)`,
    'corepack enable && corepack prepare pnpm@9 --activate',
  );
else if (pnpmV) ok(`pnpm ${/pnpm\/([\d.]+)/.exec(ua)?.[1]}`);

// 3. 依赖
const require = createRequire(path.join(root, 'package.json'));
if (!existsSync(path.join(root, 'node_modules'))) {
  bad('dependencies are not installed', 'pnpm install');
} else {
  ok('node_modules present');
}

// 4. Go 工具链（apps/desktop-go/go.mod 的 go 版本）
{
  const want = /^go (\d+)\.(\d+)/m.exec(
    readFileSync(path.join(root, 'apps/desktop-go/go.mod'), 'utf8'),
  );
  // 在模块目录里问：GOTOOLCHAIN=auto 时 go 会按 go.mod 切到（必要时下载）所需版本
  const r = spawnSync('go', ['env', 'GOVERSION'], {
    cwd: path.join(root, 'apps/desktop-go'),
    encoding: 'utf8',
  });
  const have = /go(\d+)\.(\d+)/.exec(r.stdout ?? '');
  if (r.error || r.status !== 0 || !have)
    bad('go not found on PATH', 'install Go from https://go.dev/dl/');
  else if (want && newer([+have[1], +have[2], 0], [+want[1], +want[2], 0]) < 0)
    bad(
      `${r.stdout.trim()} is too old (apps/desktop-go/go.mod needs go ${want[1]}.${want[2]})`,
      'install a newer Go from https://go.dev/dl/',
    );
  else ok(r.stdout.trim());
}

// 5. Tooling CLIs at workspace root (Windows pnpm .bin shims are fragile; scripts use run-bin.mjs)
{
  const tools = [
    ['typescript', 'typescript'],
    ['vite', 'vite'],
    ['tsup', 'tsup'],
  ];
  for (const [label, pkg] of tools) {
    try {
      const pkgJson = require.resolve(`${pkg}/package.json`);
      const ver = JSON.parse(readFileSync(pkgJson, 'utf8')).version;
      ok(`${label} ${ver} (workspace root)`);
    } catch {
      bad(`${label} not resolvable from repo root`, 'pnpm install');
    }
  }
  // Package-local link is nice-to-have; run-bin always uses root.
  try {
    createRequire(path.join(root, 'packages/ai-chat/package.json')).resolve('vite/package.json');
    ok('vite resolvable from packages/ai-chat');
  } catch {
    warn('vite is not linked under packages/ai-chat (ok — run-bin.mjs resolves from root).');
    warn(
      'If pnpm dev still fails on Windows: delete node_modules and packages/*/node_modules, then pnpm install',
    );
  }
}

// 6. 端口
const free = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true))); // 双栈（:: 同时覆盖 IPv4/IPv6）
  });
for (const [port, what] of [
  [PORTS.renderer, 'mascot renderer dev server'],
  [PORTS.chat, 'chat window dev server'],
]) {
  if (await free(port)) ok(`port ${port} free (${what})`);
  else bad(`port ${port} is in use (${what})`, `stop the other process: lsof -i :${port}`);
}

// 7. 可选：AI provider 环境变量（只提示）
if (!quick) {
  const keys = [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ];
  const set = keys.filter((k) => process.env[k]);
  if (set.length) ok(`provider keys in env: ${set.join(', ')}`);
  else
    warn(
      'no provider API key in env — add one later in the app (托盘 → AI 服务商) or export e.g. DEEPSEEK_API_KEY',
    );
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    warn('no DISPLAY — run under a desktop session or xvfb-run');
}

if (failed) {
  console.log('\nPreflight failed — fix the items above and run again.');
  process.exit(1);
}
console.log(quick ? '' : '\nAll good. Start with: pnpm dev');
