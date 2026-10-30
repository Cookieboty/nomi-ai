#!/usr/bin/env node
// 冷启动测量：多次启动 prod 构建（apps/desktop-electron/dist），全新 userData，统计各打点中位数。
// 用法（Linux 需显示）：xvfb-run -a node scripts/measure-startup.mjs [runs=7] [--json out.json]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = resolve(root, 'apps/desktop-electron');
const exe = createRequire(join(pkg, 'package.json'))('electron');
const runs = Number(process.argv[2] || 7);
const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : null;
const FINAL = 'main:mascot-model-loaded';

function once() {
  return new Promise((done) => {
    const ud = mkdtempSync(join(tmpdir(), 'perf-ud-'));
    const env = {
      ...process.env,
      IG_PERF_LOG: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    delete env.NODE_ENV;
    const t0 = Date.now();
    const child = spawn(exe, [pkg, `--user-data-dir=${ud}`, '--enable-unsafe-swiftshader'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const marks = {};
    let buf = '';
    const finish = () => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      setTimeout(() => {
        rmSync(ud, { recursive: true, force: true });
        done(marks);
      }, 300);
    };
    const timer = setTimeout(finish, 30_000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /\[perf\] (\S+) \+\d+ @(\d+)/.exec(line);
        if (m) {
          marks[m[1]] = Number(m[2]) - t0;
          if (m[1] === FINAL) setTimeout(finish, 200);
        }
      }
    });
  });
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

const all = [];
for (let i = 0; i < runs; i++) {
  const m = await once();
  all.push(m);
  console.error(`run ${i + 1}/${runs}: ${JSON.stringify(m)}`);
}
const names = [...new Set(all.flatMap((m) => Object.keys(m)))];
const summary = {};
for (const n of names) {
  const v = all.map((m) => m[n]).filter((x) => typeof x === 'number');
  summary[n] = { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length };
}
const order = Object.entries(summary).sort((a, b) => a[1].median - b[1].median);
for (const [n, s] of order)
  console.log(
    `${n.padEnd(32)} median ${String(s.median).padStart(6)} ms  (min ${s.min}, max ${s.max}, n=${s.n})`,
  );
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ runs, summary }, null, 2));
