#!/usr/bin/env node
/**
 * usage 额度子进程（claude -p /usage / codex app-server / grok agent stdio）的通用 mock。
 * 行为由环境变量 MOCK_PLAN（JSON）决定，事件记到 MOCK_LOG（每行一个 JSON）：
 *   onStart: string[]          启动后依次写到 stdout
 *   onLine: { [n]: string[] }  收到第 n 行 stdin（0 起）后写到 stdout
 *   big: number, bigChar?: string  启动后写 big 个 bigChar（默认 'x'；输出上限场景）
 *   bigAfter: number           big 改为收到第 n 行 stdin 并记录后再写（时序确定：日志里先有该行）
 *   exit: 'start' | number     启动后 / 收到第 n 行后以 code 退出
 *   code: number
 * 未要求退出时一直挂着，直到被终止。
 * 录制：record-usage-subs.mjs；Go 回放：internal/core/usage/subs_parity_test.go。
 */
import fs from 'node:fs';
import path from 'node:path';

const plan = JSON.parse(process.env.MOCK_PLAN || '{}');
const log = (o) => process.env.MOCK_LOG && fs.appendFileSync(process.env.MOCK_LOG, `${JSON.stringify(o)}\n`);
const cwd = process.cwd();
// 录制器清理前等待子进程退出用（不进 golden 日志）
if (process.env.MOCK_LOG) fs.appendFileSync(`${process.env.MOCK_LOG}.pid`, `${process.pid}\n`);
log({
  argv: process.argv.slice(2),
  cwd: path.basename(cwd).slice(0, -6),
  cwdParent: path.basename(path.dirname(cwd)),
  env: Object.fromEntries(
    ['NO_COLOR', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'MOCK_X'].map((k) => [k, process.env[k] ?? null]),
  ),
});
const out = (chunks) => {
  for (const c of chunks ?? []) process.stdout.write(c);
};
const quit = () => process.stdout.write('', () => process.exit(plan.code ?? 0));
out(plan.onStart);
if (plan.big && plan.bigAfter === undefined) process.stdout.write((plan.bigChar ?? 'x').repeat(plan.big));
if (plan.exit === 'start') quit();
else {
  let buf = '';
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      log({ line });
      out(plan.onLine?.[n]);
      if (plan.big && plan.bigAfter === n) process.stdout.write((plan.bigChar ?? 'x').repeat(plan.big));
      if (plan.exit === n) quit();
      n++;
    }
  });
  setInterval(() => {}, 1 << 30);
}
