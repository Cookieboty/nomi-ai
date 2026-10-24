/**
 * 编程助手子进程的启动：找可执行文件（含 Mock CLI）、Windows 的 npm 垫片、子进程环境、诊断记录挂钩。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { traceCliChild } from '../../diagnostics/cliTrace';
import { buildCliEnv } from '../cliEnv';
import { resolveHarnessLaunch } from '../cliLaunch';
import { peekCliBin, resolveCliBinCached, withCliPath } from '../detect';
import type { HarnessBackend } from '../types';

type CliBackend = Exclude<HarnessBackend, 'nomi'>;

function mockDir(): string {
  // packages/electron/scripts/mock-cli（开发）或随包 resources
  const candidates = [
    path.resolve(__dirname, '../../../scripts/mock-cli'),
    path.resolve(__dirname, '../../scripts/mock-cli'),
    path.resolve(process.cwd(), 'packages/electron/scripts/mock-cli'),
    path.resolve(process.cwd(), 'scripts/mock-cli'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'mock-claude.mjs'))) return c;
  }
  return candidates[0]!;
}

export function resolveHarnessBin(backend: CliBackend): string | null {
  if (process.env.NOMI_USE_MOCK_CLI === '1') {
    return path.join(mockDir(), `mock-${backend}.mjs`);
  }
  return resolveCliBinCached(backend);
}

/** 状态里展示用的可执行文件路径：只读缓存，绝不在这里 spawn（未缓存的由 refreshBins 异步补上） */
export function peekHarnessBin(backend: CliBackend): string | null {
  if (process.env.NOMI_USE_MOCK_CLI === '1') return resolveHarnessBin(backend);
  return peekCliBin(backend) ?? null;
}

export function isScript(bin: string) {
  return bin.endsWith('.mjs') || bin.endsWith('.js');
}

/** spawn 一个 CLI。Windows 的 npm 垫片先解开，避免对无扩展名脚本报 ENOENT。 */
export function spawnHarness(
  command: string,
  args: string[],
  /** tabId：诊断日志里按标签分组（§8.3）；登录进程不走这里，从不被记录（S8） */
  opts: { cwd: string; env: NodeJS.ProcessEnv; tabId?: string },
): ChildProcessWithoutNullStreams {
  const launch = resolveHarnessLaunch(command, args, opts.env);
  const child = spawn(launch.file, launch.args, {
    cwd: opts.cwd,
    env: launch.env,
    windowsHide: true,
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  // 诊断日志开着时记录收发原文（脱敏；环境变量不记）；关着什么都不做
  traceCliChild(child, command, args, { tabId: opts.tabId });
  // 子进程先退出时，之后的 stdin 写入（NDJSON / control_response / end）会异步 EPIPE；
  // 没有监听就成了主进程 uncaughtException。轮次的失败由 close / error 事件负责（#46）
  child.stdin.on('error', () => {});
  return child;
}

/**
 * Electron 的 process.execPath 是 Electron 本体；跑 .mjs/.js mock/脚本时必须带
 * ELECTRON_RUN_AS_NODE=1，否则 Windows 上会以 GUI 子系统拉起，stdin 管道失效，
 * harness 收到空输出（「无文本输出」），并发/续接用例随之失败。Node 下该变量无害。
 */
export function cliChildEnv(
  useNode: boolean,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  // 带上补全后的 PATH：`#!/usr/bin/env node` 的 CLI 要能找到 nvm / volta 等装的 node（#76）
  return buildCliEnv(
    withCliPath(process.env),
    useNode ? { ELECTRON_RUN_AS_NODE: '1', ...extra } : extra,
  );
}
