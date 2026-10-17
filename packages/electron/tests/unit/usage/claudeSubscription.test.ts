jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLAUDE_USAGE_ARGS,
  ClaudeUsageFetcher,
  claudeUsageEnv,
} from '../../../src/usage/claudeSubscription';
import { ProcessFailure, type RunResult } from '../../../src/usage/limitedProcess';

const NOW = Date.parse('2026-10-16T02:00:00Z');
const envelope = (result: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    is_error: false,
    local_command: 'usage',
    num_turns: 0,
    result,
    ...extra,
  });
const GOOD = envelope(
  'Current session: 12% used · resets 3pm (Asia/Shanghai)\nCurrent week (all models): 40% used · resets Oct 20, 3pm (Asia/Shanghai)',
);

const mk = (run: (...a: unknown[]) => Promise<RunResult>, extra = {}) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-claude-test-'));
  return {
    tmpRoot,
    f: new ClaudeUsageFetcher({
      resolveBin: async () => '/fake/claude',
      run: run as never,
      env: () => ({ PATH: '/bin' }),
      tmpRoot,
      now: () => NOW,
      ...extra,
    }),
  };
};

describe('ClaudeUsageFetcher：claude -p /usage（受限）', () => {
  it('参数与环境：受限参数、关遥测 / 错误上报 / 自动更新；超时 15s、256KB；临时目录当 cwd 并清理', async () => {
    const run = jest.fn(async () => ({ stdout: GOOD, code: 0 }));
    const { f, tmpRoot } = mk(run);
    const out = await f.fetch('Max');
    expect(out).toMatchObject({
      kind: 'ok',
      reading: {
        origin: 'usage-cmd',
        plan: 'Max',
        updatedAt: NOW,
        windows: [
          { id: 'five_hour', usedPercent: 12 },
          { id: 'seven_day', usedPercent: 40 },
        ],
      },
    });
    const [bin, args, o] = run.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe('/fake/claude');
    expect(args).toEqual(CLAUDE_USAGE_ARGS);
    expect(args).toEqual([
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
    ]);
    expect(o.timeoutMs).toBe(15_000);
    expect(o.maxBytes).toBe(256 * 1024);
    expect(path.dirname(o.cwd as string)).toBe(tmpRoot);
    expect(fs.existsSync(o.cwd as string)).toBe(false);
    expect(claudeUsageEnv({ PATH: '/bin' })).toMatchObject({
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
    });
  });

  it('子进程失败：超时 / 输出超限 / 启动失败 → 暂时性；找不到 claude → not-installed', async () => {
    for (const [kind, reason] of [
      ['timeout', 'timeout'],
      ['output-limit', 'output-limit'],
      ['failed', 'spawn-failed'],
      ['not-installed', 'not-installed'],
    ] as const) {
      const { f } = mk(async () => {
        throw new ProcessFailure(kind);
      });
      expect(await f.fetch()).toEqual({ kind: 'transient', reason });
    }
    const none = new ClaudeUsageFetcher({ resolveBin: async () => null });
    expect(await none.fetch()).toEqual({ kind: 'transient', reason: 'not-installed' });
  });

  it('认证类：输出里是 401 / 未登录 → auth', async () => {
    const { f } = mk(async () => ({
      stdout: envelope('Not logged in · Please run /login'),
      code: 1,
    }));
    expect(await f.fetch()).toEqual({ kind: 'auth', reason: 'denied' });
  });

  it('只有费用没有额度行 / 非 0 退出码 / 坏输出：暂时性', async () => {
    const cost = mk(async () => ({ stdout: envelope('Total cost: $0.00'), code: 0 }));
    expect(await cost.f.fetch()).toEqual({ kind: 'transient', reason: 'no-limits' });
    const bad = mk(async () => ({ stdout: 'garbage', code: 0 }));
    expect(await bad.f.fetch()).toEqual({ kind: 'transient', reason: 'bad-output' });
    const code = mk(async () => ({ stdout: GOOD, code: 2 }));
    expect(await code.f.fetch()).toEqual({ kind: 'transient', reason: 'bad-output' });
  });

  it('不支持 /usage：安静降级，并记住——本次运行不再拉起 claude', async () => {
    const run = jest.fn(async () => ({ stdout: envelope('Unknown skill: usage'), code: 0 }));
    const { f } = mk(run);
    expect(await f.fetch()).toEqual({ kind: 'transient', reason: 'unsupported' });
    expect(f.isUnsupported()).toBe(true);
    expect(await f.fetch()).toEqual({ kind: 'transient', reason: 'unsupported' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('真实子进程（假的 claude 脚本）：stderr 里的内容不会进入结果，stdout 超限被终止', async () => {
    // 假 CLI 脚本靠 shebang + 可执行位启动，仅 POSIX 可用
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-fakeclaude-'));
    const bin = path.join(dir, 'claude');
    const script = (body: string) =>
      fs.writeFileSync(bin, `#!${process.execPath}\n${body}`, { mode: 0o755 });
    script(
      `console.error('TOKEN-IN-STDERR sk-secret');process.stdout.write(${JSON.stringify(GOOD)});`,
    );
    const f = new ClaudeUsageFetcher({
      resolveBin: async () => bin,
      env: () => ({ ...process.env }),
      now: () => NOW,
    });
    const out = await f.fetch();
    expect(out.kind).toBe('ok');
    expect(JSON.stringify(out)).not.toContain('sk-secret');
    script(`process.stdout.write('x'.repeat(400*1024));setInterval(()=>{},1000)`);
    expect(await f.fetch()).toEqual({ kind: 'transient', reason: 'output-limit' });
    script(`setInterval(()=>{},1000)`);
    const slow = new ClaudeUsageFetcher({
      resolveBin: async () => bin,
      env: () => ({ ...process.env }),
      timeoutMs: 300,
    });
    expect(await slow.fetch()).toEqual({ kind: 'transient', reason: 'timeout' });
  });
});
