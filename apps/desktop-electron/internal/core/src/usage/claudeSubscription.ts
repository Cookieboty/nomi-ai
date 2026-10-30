/**
 * Claude Code 额度兜底：用户点「刷新」且状态栏快照缺失 / 过期时，运行官方
 * `claude -p /usage --output-format json`，由 Claude Code 自己用自己的登录态去取，Nomi 不接触任何凭据。
 *
 * 实测（claude 2.1.299）：-p 下 /usage 是本地命令（信封里 local_command = "usage"、num_turns = 0，不调用模型）；
 * 但社区 issue 里也有旧版本 / 其它模式下 `Unknown skill: usage` 的说法 —— 所以输出里认不出就安静降级
 * （ClaudeUsageFetcher 会记住「不支持」，本次运行内不再重复拉起）。
 *
 * 受限子进程：临时目录当 cwd；--tools '' --strict-mcp-config --setting-sources '' --no-session-persistence；
 * 关遥测 / 错误上报 / 自动更新；超时 15 秒；stdout 上限 256KB；stderr 丢弃；Windows .cmd 垫片逐参引号；GUI PATH 补全。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCliBinAsync, withCliPath } from '../cli/detect';

import { parseClaudeUsageResult } from './claudeUsageParser';
import {
  ProcessFailure,
  STDOUT_LIMIT,
  runLimited,
  type RunOptions,
  type RunResult,
} from './limitedProcess';
import type { FetchOutcome } from './quotaCache';

export const CLAUDE_USAGE_ARGS = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--no-session-persistence',
];

export const CLAUDE_USAGE_TIMEOUT_MS = 15_000;

export function claudeUsageEnv(base: NodeJS.ProcessEnv = withCliPath()): NodeJS.ProcessEnv {
  return {
    ...base,
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    NO_COLOR: '1',
  };
}

export interface ClaudeFetcherDeps {
  resolveBin?: () => Promise<string | null>;
  run?: (cmd: string, args: string[], o: RunOptions) => Promise<RunResult>;
  env?: () => NodeJS.ProcessEnv;
  tmpRoot?: string;
  now?: () => number;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

export class ClaudeUsageFetcher {
  private unsupported = false;

  constructor(private readonly d: ClaudeFetcherDeps = {}) {}

  isUnsupported(): boolean {
    return this.unsupported;
  }

  async fetch(plan?: string): Promise<FetchOutcome> {
    if (this.unsupported) return { kind: 'transient', reason: 'unsupported' };
    const bin = await (this.d.resolveBin ?? (() => resolveCliBinAsync('claude')))().catch(
      () => null,
    );
    if (!bin) return { kind: 'transient', reason: 'not-installed' };
    const dir = fs.mkdtempSync(path.join(this.d.tmpRoot ?? os.tmpdir(), 'nomi-claude-usage-'));
    const now = this.d.now ? this.d.now() : Date.now();
    try {
      const r = await (this.d.run ?? runLimited)(bin, CLAUDE_USAGE_ARGS, {
        cwd: dir,
        env: (this.d.env ?? claudeUsageEnv)(),
        timeoutMs: this.d.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS,
        maxBytes: STDOUT_LIMIT,
        platform: this.d.platform,
      });
      const p = parseClaudeUsageResult(r.stdout, now);
      if (p.unsupported) {
        this.unsupported = true;
        return { kind: 'transient', reason: 'unsupported' };
      }
      if (p.denied) return { kind: 'auth', reason: 'denied' };
      if (r.code !== 0 || p.isError) return { kind: 'transient', reason: 'bad-output' };
      if (!p.windows.length) return { kind: 'transient', reason: 'no-limits' };
      return {
        kind: 'ok',
        reading: {
          windows: p.windows,
          updatedAt: now,
          origin: 'usage-cmd',
          ...(plan ? { plan } : {}),
        },
      };
    } catch (e) {
      if (e instanceof ProcessFailure) {
        const reason =
          e.kind === 'timeout'
            ? 'timeout'
            : e.kind === 'output-limit'
              ? 'output-limit'
              : e.kind === 'not-installed'
                ? 'not-installed'
                : 'spawn-failed';
        return { kind: 'transient', reason };
      }
      return { kind: 'transient', reason: 'spawn-failed' };
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 临时目录清理失败不影响结果 */
      }
    }
  }
}
