jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import {
  SCRIPT_FILE,
  SNAPSHOT_FILE,
  disableHook,
  enableHook,
  hookStatus,
  parseStatuslineRateLimits,
  readStatuslineSnapshot,
} from '../../../src/usage/claudeStatusline';
import { UsageService } from '../../../src/usage/UsageService';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const settingsOf = (home: string) => path.join(home, '.claude', 'settings.json');
const readJson = (f: string) =>
  JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, Record<string, unknown>>;
const put = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};
const posix = process.platform === 'win32' ? it.skip : it;

// 官方文档里的 statusline 输入示例（https://code.claude.com/docs/en/statusline）
const OFFICIAL = {
  session_id: 'abc123',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
};

describe('parseStatuslineRateLimits', () => {
  it('官方字段：five_hour / seven_day 的 used_percentage + resets_at（秒）', () => {
    const r = parseStatuslineRateLimits(JSON.stringify(OFFICIAL), 5)!;
    expect(r.updatedAt).toBe(5);
    expect(r.windows).toEqual([
      { id: 'five_hour', usedPercent: 23.5, windowMinutes: 300, resetAt: 1738425600_000 },
      { id: 'seven_day', usedPercent: 41.2, windowMinutes: 10080, resetAt: 1738857600_000 },
    ]);
  });
  it('窗口可单独缺失；ISO 字符串重置时间也接受；超过 100 按 100', () => {
    const r = parseStatuslineRateLimits(
      JSON.stringify({
        rate_limits: { seven_day: { used_percentage: 130, resets_at: '2026-03-24T00:00:00Z' } },
      }),
      1,
    )!;
    expect(r.windows).toEqual([
      {
        id: 'seven_day',
        usedPercent: 100,
        windowMinutes: 10080,
        resetAt: Date.parse('2026-03-24T00:00:00Z'),
      },
    ]);
  });
  it('API 用户（没有 rate_limits）/ 坏 JSON / 坏值：null，不编造', () => {
    expect(parseStatuslineRateLimits('{"model":{}}', 1)).toBeNull();
    expect(parseStatuslineRateLimits('not json', 1)).toBeNull();
    expect(
      parseStatuslineRateLimits('{"rate_limits":{"five_hour":{"used_percentage":"x"}}}', 1),
    ).toBeNull();
    expect(
      parseStatuslineRateLimits('{"rate_limits":{"five_hour":{"used_percentage":-1}}}', 1),
    ).toBeNull();
  });
});

describe('statusline 钩子：开启 / 关闭 / 恢复', () => {
  const setup = () => {
    const home = tmp('nomi-sl-home-');
    const root = tmp('nomi-sl-root-');
    return { home, root, dep: { home, root, env: {}, platform: 'darwin' as const } };
  };

  it('没有 settings.json：开启后创建，只加 statusLine；关闭后删除该键并清理文件', () => {
    const { home, root, dep } = setup();
    expect(hookStatus(dep)).toMatchObject({
      supported: true,
      enabled: false,
      hadOwnStatusLine: false,
    });
    const st = enableHook(dep);
    expect(st.enabled).toBe(true);
    const sl = readJson(settingsOf(home)).statusLine;
    expect(sl.type).toBe('command');
    expect(sl.command).toContain(path.join(root, SCRIPT_FILE));
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(root, SCRIPT_FILE)).mode & 0o111).not.toBe(0);
    disableHook(dep);
    expect(readJson(settingsOf(home)).statusLine).toBeUndefined();
    expect(fs.existsSync(path.join(root, SCRIPT_FILE))).toBe(false);
  });

  posix('已有自己的 statusLine：备份、保留 padding、串接执行，关闭时原样恢复；其它字段不动', () => {
    const { home, root, dep } = setup();
    const orig = { type: 'command', command: 'echo ORIGINAL-LINE', padding: 2 };
    put(settingsOf(home), JSON.stringify({ model: 'opus', env: { A: '1' }, statusLine: orig }));
    const st = enableHook(dep);
    expect(st).toMatchObject({ enabled: true, hadOwnStatusLine: true });
    const after = readJson(settingsOf(home));
    expect(after.model).toBe('opus');
    expect(after.env).toEqual({ A: '1' });
    expect(after.statusLine.padding).toBe(2);
    const once = fs.readFileSync(settingsOf(home), 'utf8');
    enableHook(dep);
    expect(fs.readFileSync(settingsOf(home), 'utf8')).toBe(once);

    // 真的跑一遍脚本：落快照 + 原命令输出
    const out = execFileSync('sh', [path.join(root, SCRIPT_FILE)], {
      input: JSON.stringify(OFFICIAL),
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ORIGINAL-LINE');
    const snap = path.join(root, SNAPSHOT_FILE);
    if (process.platform !== 'win32') expect(fs.statSync(snap).mode & 0o077).toBe(0);
    expect(readStatuslineSnapshot(root)!.windows.map((w) => w.id)).toEqual([
      'five_hour',
      'seven_day',
    ]);

    disableHook(dep);
    expect(readJson(settingsOf(home)).statusLine).toEqual(orig);
    expect(fs.existsSync(snap)).toBe(false);
  });

  it('settings.json 不是合法 JSON：拒绝开启且不改动文件', () => {
    const { home, dep } = setup();
    put(settingsOf(home), '{ broken');
    expect(() => enableHook(dep)).toThrow('invalid-settings');
    expect(fs.readFileSync(settingsOf(home), 'utf8')).toBe('{ broken');
    expect(hookStatus(dep).problem).toBe('invalid-settings');
  });

  it('原 statusLine 不是 command 类型：拒绝（不覆盖用户的配置）', () => {
    const { home, dep } = setup();
    put(settingsOf(home), JSON.stringify({ statusLine: { type: 'other' } }));
    expect(() => enableHook(dep)).toThrow('unsupported-statusline');
  });

  it('Windows 暂不支持；重复开启幂等；用户在开启后又改了 statusLine：关闭时不覆盖', () => {
    const { home, dep } = setup();
    expect(() => enableHook({ ...dep, platform: 'win32' })).toThrow('unsupported-platform');
    enableHook(dep);
    enableHook(dep);
    const once = fs.readFileSync(settingsOf(home), 'utf8');
    enableHook(dep);
    expect(fs.readFileSync(settingsOf(home), 'utf8')).toBe(once);
    const mine = { type: 'command', command: 'echo mine' };
    put(settingsOf(home), JSON.stringify({ statusLine: mine }));
    disableHook(dep);
    expect(readJson(settingsOf(home)).statusLine).toEqual(mine);
  });
});

describe('statusline 钩子：尊重 CLAUDE_CONFIG_DIR', () => {
  it('配置目录被改到别处时，读写的是那个目录里的 settings.json，不碰默认的 ~/.claude', () => {
    const home = tmp('nomi-hook-home-');
    const cfg = tmp('nomi-hook-cfg-');
    const root = tmp('nomi-hook-root-');
    put(path.join(home, '.claude', 'settings.json'), '{"theme":"default"}');
    put(path.join(cfg, 'settings.json'), '{"theme":"custom"}');
    const dep = { root, home, env: { CLAUDE_CONFIG_DIR: cfg }, platform: 'linux' as const };
    enableHook(dep);
    expect(readJson(path.join(cfg, 'settings.json')).statusLine).toBeTruthy();
    expect(fs.readFileSync(settingsOf(home), 'utf8')).toBe('{"theme":"default"}');
    expect(hookStatus(dep).enabled).toBe(true);
    disableHook(dep);
    expect(readJson(path.join(cfg, 'settings.json')).statusLine).toBeUndefined();
    expect(readJson(path.join(cfg, 'settings.json')).theme).toBe('custom');
  });
});

describe('UsageService：Claude 额度（订阅 + 快照）与按登录方式过滤', () => {
  const mk = (run: (k: 'claude' | 'codex') => Promise<string | null>) => {
    const root = tmp('nomi-sl-svc-');
    const home = tmp('nomi-sl-svc-home-');
    put(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), '');
    put(path.join(home, '.codex', 'sessions', '2026', '10', '16', 'rollout-x.jsonl'), '');
    const svc = new UsageService({
      events: createRecordingAppEvents(),
      root,
      home,
      dshHome: path.join(home, '.dsh'),
      scanMs: 0,
      authRun: run,
      platform: 'darwin',
      logger: { info: jest.fn(), warn: jest.fn() },
    });
    return { svc, root, home };
  };
  const sub = async (k: 'claude' | 'codex') =>
    k === 'claude' ? JSON.stringify({ authMethod: 'claude.ai' }) : 'Logged in using ChatGPT';

  it('订阅登录 + 还没开 statusline：被动查看不探测登录（Claude 暂不出现）；开启并收到快照后显示 5 小时 / 每周', async () => {
    const run = jest.fn(sub);
    const { svc, root } = mk(run);
    await svc.scan();
    let v = await svc.quotaView();
    // 被动读取从不启动官方 CLI 的登录探测；没有任何本地线索时保持 unknown、不出现
    expect(run).not.toHaveBeenCalled();
    expect(v.find((e) => e.id === 'claude')).toBeUndefined();
    expect(v.find((e) => e.id === 'nomi')).toBeUndefined();

    svc.setQuotaHook(true);
    fs.writeFileSync(path.join(root, SNAPSHOT_FILE), JSON.stringify(OFFICIAL));
    v = await svc.quotaView();
    const c = v.find((e) => e.id === 'claude')!;
    expect(c.status).toBe('ok');
    expect(run).not.toHaveBeenCalled();
    expect(c.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['five_hour', 23.5],
      ['seven_day', 41.2],
    ]);
    // 清空用量记录时一并删掉快照
    svc.clear();
    expect(fs.existsSync(path.join(root, SNAPSHOT_FILE))).toBe(false);
  });

  it('API 配置的 Claude / Codex（本地配置可判断）：不展示额度，只标 API 计费，也不起进程', async () => {
    const run = jest.fn(async () => null);
    const { svc, home } = mk(run);
    put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/key' }));
    put(path.join(home, '.codex', 'config.toml'), 'forced_login_method = "api"\n');
    await svc.scan();
    const v = await svc.quotaView();
    expect(v.filter((e) => ['claude', 'codex'].includes(e.id)).map((e) => e.status)).toEqual([
      'api',
      'api',
    ]);
    expect(run).not.toHaveBeenCalled();
  });
});
