#!/usr/bin/env node
// `pnpm dev` 冒烟测试（CI 用，也可本地跑）：启动完整开发栈，等到
//   - 桌面角色窗口加载完成（main-did-finish-load）
//   - 桌面角色模型加载完成（main:mascot-model-loaded）
//   - 对话窗口 dev server（:6128，dev-ports.json）返回页面
// 然后结束整个进程树。超时或进程提前退出则失败并打印日志尾部。
// 用法：node scripts/dev-smoke.mjs [timeoutSec=420]   （Linux 无显示器：xvfb-run -a node scripts/dev-smoke.mjs）
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEV_HOST, PORTS } from './ports.mjs';

const timeoutMs = Number(process.argv[2] ?? 420) * 1000;
const ud = mkdtempSync(path.join(os.tmpdir(), 'cd-dev-smoke-'));
const need = {
  'main window loaded': /\[perf\] main-did-finish-load/,
  'mascot model loaded': /\[perf\] main:mascot-model-loaded/,
};
const seen = new Set();
const tail = [];
const win = process.platform === 'win32';
const child = spawn(win ? 'pnpm.cmd' : 'pnpm', ['dev'], {
  shell: win,
  detached: !win,
  env: {
    ...process.env,
    IG_PERF_LOG: '1',
    CI: process.env.CI ?? '1',
    ELECTRON_ARGS: `--enable-unsafe-swiftshader --user-data-dir=${ud} ${process.env.ELECTRON_ARGS ?? ''}`,
  },
});

let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  console.info(`\n[dev-smoke] ${msg}`);
  if (code) console.info('---- last log lines ----\n' + tail.join('\n'));
  try {
    if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // 进程已退出
  }
  setTimeout(() => process.exit(code), 3000);
};

const onData = async (buf) => {
  for (const line of buf.toString().split(/\r?\n/)) {
    if (!line.trim()) continue;
    tail.push(line);
    if (tail.length > 120) tail.shift();
    if (/\[electron:dev\]|\[perf\]|✖|ERROR/.test(line)) console.info(line);
    for (const [k, re] of Object.entries(need)) if (re.test(line) && !seen.has(k)) seen.add(k);
  }
  if (seen.size === Object.keys(need).length && !done) {
    try {
      const html = await (await fetch(`http://${DEV_HOST}:${PORTS.chat}/`)).text();
      if (!/<div id="root"|<script/.test(html))
        return finish(1, 'chat window dev server returned unexpected HTML');
    } catch (e) {
      return finish(1, `chat window dev server not reachable: ${e}`);
    }
    finish(0, `OK — ${[...seen].join(', ')}, chat window served`);
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (code) =>
  finish(1, `pnpm dev exited early (code ${code}); saw: ${[...seen].join(', ') || 'nothing'}`),
);
setTimeout(
  () => finish(1, `timeout after ${timeoutMs / 1000}s; saw: ${[...seen].join(', ') || 'nothing'}`),
  timeoutMs,
);
