/**
 * 外部插件（L1 声明式，docs/design/cli-plugin-architecture.md §5.9 / P10.3）的真实进程用例：
 * 清单 → 参数模板 → 起进程（不经 shell）→ 通用 ACP 驱动。
 * - mock-acp.mjs：添加 → 对话 → 进程重启后 session/load 续接；
 * - 本机装了 Gemini / Grok 时，把它们当作「用户添加的外部 CLI」只做握手（不建会话、不联网发消息）。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AcpDriver } from '../../packages/cli-sdk/src/drivers/acp';
import { probeAcp } from '../../packages/cli-sdk/src/drivers/acpProbe';
import {
  externalManifest,
  renderExternalArgs,
  validateExternalSpec,
  type ExternalCliSpec,
} from '../../packages/cli-sdk/src/external';
import { validateManifest } from '../../packages/cli-sdk/src/manifest';

const MOCK = path.resolve(__dirname, '../../packages/core/scripts/mock-cli/mock-acp.mjs');
const RESERVED = ['claude', 'codex', 'dsh', 'gemini', 'grok', 'nomi'];
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 与主进程一致：清单命令是脚本时用 node 跑；参数只做占位符替换，不经 shell */
function launch(spec: ExternalCliSpec, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const args = renderExternalArgs(spec.args, { cwd, home: os.homedir() });
  const script = spec.command.endsWith('.mjs');
  return spawn(script ? process.execPath : spec.command, script ? [spec.command, ...args] : args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const has = (bin: string) => {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
};

describe('外部 ACP CLI：mock-acp', () => {
  const spec: ExternalCliSpec = {
    version: 1,
    id: 'mock-acp',
    displayName: 'Mock ACP',
    command: MOCK,
    args: ['acp', '--cwd', '{cwd}'],
  };

  it('清单合法；生成的插件清单通过契约校验', () => {
    expect(validateExternalSpec(spec, RESERVED)).toEqual([]);
    expect(validateManifest(externalManifest(spec))).toEqual([]);
  });

  it('添加 → 对话 → 进程重启后续接同一会话', async () => {
    const cwd = tmp('ext-acp-cwd-');
    const env = { NOMI_MOCK_ACP_DIR: tmp('ext-acp-sessions-') };
    const run = async (resumeId: string | null, text: string) => {
      const child = launch(spec, cwd, env);
      const driver = new AcpDriver({ child });
      const r = await driver.start({ cwd, resumeId });
      const turn = await driver.send({ text });
      await driver.close();
      return { sessionId: r.sessionId, resumed: r.resumed, text: turn.text };
    };
    const first = await run(null, 'hello');
    expect(first.text).toBe('external: hello (turn 1)');
    const second = await run(first.sessionId, 'again');
    expect(second).toMatchObject({
      sessionId: first.sessionId,
      resumed: true,
      text: 'external: again (turn 2)',
    });
  });
});

describe.each([
  { bin: 'gemini', args: ['--acp'] },
  { bin: 'grok', args: ['agent', 'stdio'] },
])('真实 CLI 当作外部插件：$bin（只握手）', ({ bin, args }) => {
  it.skipIf(!has(bin))('initialize 握手报告协议版本与能力', async () => {
    const spec: ExternalCliSpec = {
      version: 1,
      id: `my-${bin}`,
      displayName: bin,
      command: bin,
      args,
    };
    expect(validateExternalSpec(spec, RESERVED)).toEqual([]);
    const cwd = tmp(`ext-${bin}-`);
    // 用临时 HOME：不读写用户自己的 CLI 配置（来源隔离 S1）
    const home = tmp(`ext-${bin}-home-`);
    const child = launch(spec, cwd, { HOME: home, GEMINI_CLI_HOME: home, GROK_HOME: home });
    const r = await probeAcp(child, { timeoutMs: 60_000 });
    expect(r.protocolVersion).toBe(1);
    expect(typeof r.capabilities.loadSession).toBe('boolean');
  });
});
