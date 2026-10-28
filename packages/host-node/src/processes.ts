/**
 * 工具子进程的 Node 实现（`ProcessesPort.fork`，docs/design/core-host-decoupling.md §6.3）：无界面宿主要跑统一网关、
 * 文档解析这类子进程时用它（Electron 宿主用 `utilityProcess`）。
 *
 * 子进程脚本按 Electron 的约定经 `process.parentPort` 收发（`on('message', ({ data }) => …)` / `postMessage`）；
 * 这里用 Node 的 IPC 通道（`serialization: 'advanced'`，结构化克隆，与 utilityProcess 一致）在子进程里补上
 * `process.parentPort`，再 `require` 目标脚本。父进程断开时子进程退出。
 */

import { spawn } from 'node:child_process';

import type { UtilityProcess, UtilityProcessOptions } from '@nomi-ai/host-ports';

/** 子进程入口（`node -e`）：argv[1] 是目标脚本 */
const BOOTSTRAP = [
  'const target = process.argv[1];',
  'process.argv.splice(1, 1);',
  'const listeners = [];',
  "process.on('message', (data) => { for (const fn of listeners) fn({ data }); });",
  'process.parentPort = {',
  "  on(ev, fn) { if (ev === 'message') listeners.push(fn); },",
  '  postMessage(m) { if (process.connected) process.send(m); },',
  '};',
  "process.on('disconnect', () => process.exit(0));",
  'require(target);',
].join('\n');

export function forkUtilityProcess(
  modulePath: string,
  opts: UtilityProcessOptions = {},
): UtilityProcess {
  const stdio = opts.stdio ?? 'ignore';
  const child = spawn(
    process.execPath,
    [...(opts.execArgv ?? []), '-e', BOOTSTRAP, modulePath, ...(opts.args ?? [])],
    {
      stdio: [stdio, stdio, stdio, 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    },
  );
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  return {
    postMessage(message) {
      if (child.connected) child.send(message as never);
    },
    on(event: 'message' | 'exit', fn: (arg: never) => void) {
      const call = fn as (arg: unknown) => void;
      if (event === 'message') child.on('message', (m) => call(m));
      else child.on('exit', (code, signal) => call(code ?? (signal ? 1 : 0)));
    },
    kill() {
      if (exited()) return false;
      return child.kill();
    },
  } as UtilityProcess;
}
