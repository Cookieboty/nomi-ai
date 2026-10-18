jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UsageLedger } from '../../../src/usage/UsageLedger';
import { UsageLogScanner } from '../../../src/usage/UsageLogScanner';

const mk = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-root-'));
  const ledger = new UsageLedger({ root });
  let clearedAt = 0;
  let busy = false;
  const scanner = new UsageLogScanner({
    ledger,
    home,
    dshHome: path.join(home, '.dsh'),
    env: {},
    retention: () => '1y',
    clearedAt: () => clearedAt,
    routeBusy: () => busy,
  });
  return {
    home,
    ledger,
    scanner,
    setCleared: (n: number) => (clearedAt = n),
    setBusy: (b: boolean) => (busy = b),
  };
};

const NOW = new Date().toISOString();
const asst = (id: string, out: number, ts = NOW) =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: 's1',
    cwd: '/w/app',
    message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: out } },
  })}\n`;

const claudeFile = (home: string) => {
  const dir = path.join(home, '.claude', 'projects', '-w-app');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 's1.jsonl');
};

describe('UsageLogScanner：增量游标 + 去重', () => {
  it('首扫读入，再扫没变化不重读；追加只读新增行', async () => {
    const { home, ledger, scanner } = mk();
    const f = claudeFile(home);
    fs.writeFileSync(f, asst('msg_1', 5) + asst('msg_2', 6));
    expect((await scanner.scan()).added).toBe(2);
    expect(ledger.size()).toBe(2);
    const off = ledger.cursor(f)!.offset;
    expect(off).toBe(fs.statSync(f).size);

    expect((await scanner.scan()).added).toBe(0);
    fs.appendFileSync(f, asst('msg_3', 7));
    expect((await scanner.scan()).added).toBe(1);
    expect(ledger.size()).toBe(3);
    expect(ledger.cursor(f)!.offset).toBeGreaterThan(off);
  });

  it('半行不吞：游标停在最后一个换行，补全后再读到', async () => {
    const { home, ledger, scanner } = mk();
    const f = claudeFile(home);
    const full = asst('msg_9', 9);
    fs.writeFileSync(f, asst('msg_8', 8) + full.slice(0, 40));
    await scanner.scan();
    expect(ledger.size()).toBe(1);
    fs.appendFileSync(f, full.slice(40));
    await scanner.scan();
    expect(ledger.size()).toBe(2);
  });

  it('同一消息分多行写（token 递增）与续接会话复制旧消息：同键只记一次、取最大', async () => {
    const { home, ledger, scanner } = mk();
    const f = claudeFile(home);
    fs.writeFileSync(f, asst('msg_1', 3) + asst('msg_1', 30));
    const f2 = path.join(path.dirname(f), 's2.jsonl'); // 续接：复制了旧消息
    fs.writeFileSync(f2, asst('msg_1', 30) + asst('msg_5', 4));
    await scanner.scan();
    expect(ledger.size()).toBe(2);
    expect(ledger.all().find((r) => r.key === 'claude:msg_1')!.output).toBe(30);
  });

  it('文件被截断 / 重写后从头读', async () => {
    const { home, ledger, scanner } = mk();
    const f = claudeFile(home);
    fs.writeFileSync(f, asst('msg_1', 1) + asst('msg_2', 2) + asst('msg_3', 3));
    await scanner.scan();
    fs.writeFileSync(f, asst('msg_4', 4));
    await scanner.scan();
    expect(ledger.all().some((r) => r.key === 'claude:msg_4')).toBe(true);
  });

  it('Codex：续读靠游标里的 state（会话 id / 模型）', async () => {
    const { home, ledger, scanner } = mk();
    const dir = path.join(home, '.codex', 'sessions', '2026', '10', '14');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'rollout-x.jsonl');
    const L = (o: unknown) => `${JSON.stringify(o)}\n`;
    const tc = (total: number) =>
      L({
        timestamp: NOW,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: total },
            last_token_usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 },
          },
        },
      });
    fs.writeFileSync(
      f,
      L({ timestamp: NOW, type: 'session_meta', payload: { id: 'sid-9', cwd: '/w/p' } }) +
        L({ timestamp: NOW, type: 'turn_context', payload: { model: 'gpt-5' } }) +
        tc(55),
    );
    await scanner.scan();
    fs.appendFileSync(f, tc(110));
    await scanner.scan();
    const recs = ledger.all().filter((r) => r.source === 'codex');
    expect(recs.map((r) => r.key).sort()).toEqual(['codex:sid-9:110', 'codex:sid-9:55']);
    expect(recs.every((r) => r.model === 'gpt-5' && r.session === 'sid-9')).toBe(true);
  });

  it('走了本地路由的请求以路由记录为准：日志里同一时段的同来源记录跳过', async () => {
    const { home, ledger, scanner } = mk();
    const f = claudeFile(home);
    const ts = Date.now() - 5_000;
    ledger.upsert({
      key: 'route-1',
      ts: ts - 2_000,
      dur: 4_000,
      source: 'claude',
      via: 'route',
      model: 'deepseek-x',
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
    fs.writeFileSync(
      f,
      asst('msg_routed', 5, new Date(ts).toISOString()) +
        asst('msg_direct', 5, new Date(ts - 3_600_000).toISOString()),
    );
    await scanner.scan();
    const keys = ledger.all().map((r) => r.key);
    expect(keys).toContain('claude:msg_direct');
    expect(keys).not.toContain('claude:msg_routed');
    // 路由记录不带会话；日志只补会话 / 项目归属，token 不变（会话累计才不会漏掉路由请求）
    const routed = ledger.all().find((r) => r.key === 'route-1')!;
    expect(routed).toMatchObject({ session: 's1', project: 'app', input: 10, output: 5 });
  });

  it('onNew 只对真正新增的记录触发（被路由覆盖的 / 重复的不触发）', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-home-'));
    const ledger = new UsageLedger({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-ur-')) });
    const seen: string[] = [];
    const scanner = new UsageLogScanner({
      ledger,
      home,
      dshHome: path.join(home, '.dsh'),
      env: {},
      retention: () => '1y',
      onNew: (r) => seen.push(r.key),
    });
    const f = claudeFile(home);
    fs.writeFileSync(f, asst('msg_1', 5));
    await scanner.scan();
    await scanner.scan();
    fs.appendFileSync(f, asst('msg_2', 6));
    await scanner.scan();
    expect(seen).toEqual(['claude:msg_1', 'claude:msg_2']);
  });

  it('该来源有路由请求在飞时先不读它的日志（游标不动），结束后补读', async () => {
    const { home, ledger, scanner, setBusy } = mk();
    const f = claudeFile(home);
    fs.writeFileSync(f, asst('msg_1', 1));
    setBusy(true);
    await scanner.scan();
    expect(ledger.size()).toBe(0);
    expect(ledger.cursor(f)).toBeUndefined();
    setBusy(false);
    await scanner.scan();
    expect(ledger.size()).toBe(1);
  });

  it('Grok 旧游标重读 usage.modelUsage，把 unknown 换成真实模型', async () => {
    const { home, ledger, scanner } = mk();
    const dir = path.join(home, '.grok', 'sessions', 'cwd', 'sess-1');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'updates.jsonl');
    const ts = new Date().toISOString();
    fs.writeFileSync(
      f,
      `${JSON.stringify({
        timestamp: ts,
        params: {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'p1',
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              modelUsage: { 'grok-4.7-build': { inputTokens: 10, outputTokens: 4 } },
            },
          },
        },
      })}\n`,
    );
    const st = fs.statSync(f);
    ledger.upsert({
      key: 'grok:sess-1:p1',
      ts: Date.parse(ts),
      source: 'grok',
      via: 'log',
      provider: 'xai',
      model: 'unknown',
      input: 10,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      session: 'sess-1',
    });
    ledger.setCursor(f, {
      offset: st.size,
      size: st.size,
      mtimeMs: st.mtimeMs,
      state: { sid: 'sess-1' },
    });
    expect((await scanner.scan()).added).toBeGreaterThan(0);
    expect(ledger.all().find((r) => r.key === 'grok:sess-1:p1')?.model).toBe('grok-4.7-build');
    expect(ledger.cursor(f)?.state?.rev).toBe(2);
    expect((await scanner.scan()).added).toBe(0);
  });

  it('一键清空之前的内容不再导入', async () => {
    const { home, ledger, scanner, setCleared } = mk();
    const f = claudeFile(home);
    const old = new Date(Date.now() - 3_600_000).toISOString();
    fs.writeFileSync(f, asst('msg_old', 1, old));
    setCleared(Date.now() - 1_000);
    fs.appendFileSync(f, asst('msg_new', 2, new Date().toISOString()));
    await scanner.scan();
    expect(ledger.all().map((r) => r.key)).toEqual(['claude:msg_new']);
  });

  it('检测到的工具；没有任何日志目录时不报错', async () => {
    const { home, scanner } = mk();
    expect(scanner.detected()).toEqual([]);
    expect(await scanner.scan()).toEqual({ added: 0, files: 0 });
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
    expect(scanner.detected()).toEqual(['claude', 'codex']);
  });

  it('Gemini 整份 JSON：变化才重解析，重复解析不重复计数', async () => {
    const { home, ledger, scanner } = mk();
    const dir = path.join(home, '.gemini', 'tmp', 'h1', 'chats');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'session-1.json');
    const body = (n: number) =>
      JSON.stringify({
        sessionId: 'g1',
        messages: Array.from({ length: n }, (_, i) => ({
          id: `m${i}`,
          type: 'gemini',
          model: 'gemini-2.5-flash',
          timestamp: NOW,
          tokens: { input: 10, output: 5, cached: 0 },
        })),
      });
    fs.writeFileSync(f, body(1));
    await scanner.scan();
    expect(ledger.size()).toBe(1);
    fs.writeFileSync(f, body(2));
    await scanner.scan();
    expect(ledger.size()).toBe(2);
  });

  it('Gemini 新版 jsonl（含 subagent 子目录递归）：同 id 取最后一条，旧 .json 并存', async () => {
    const { home, ledger, scanner } = mk();
    const dir = path.join(home, '.gemini', 'tmp', 'myproj', 'chats');
    fs.mkdirSync(path.join(dir, 'parent-1'), { recursive: true });
    const msg = (id: string, out: number) =>
      `${JSON.stringify({
        id,
        type: 'gemini',
        model: 'gemini-2.5-flash',
        timestamp: NOW,
        tokens: { input: 10, output: out, cached: 4, thoughts: 1, tool: 0 },
      })}\n`;
    const head = `${JSON.stringify({ sessionId: 'main-1', startTime: NOW })}\n`;
    fs.writeFileSync(path.join(dir, 'session-a.jsonl'), head + msg('m1', 1) + msg('m1', 5));
    fs.writeFileSync(path.join(dir, 'parent-1', 'sub-9.jsonl'), msg('s1', 2));
    // 目录里别的 .jsonl 但不是 session- 前缀 → 不读
    fs.writeFileSync(path.join(dir, 'notes.jsonl'), msg('z1', 3));
    fs.writeFileSync(
      path.join(dir, 'session-old.json'),
      JSON.stringify({
        sessionId: 'old-1',
        messages: [
          {
            id: 'o1',
            type: 'gemini',
            timestamp: NOW,
            model: 'gemini-2.5-pro',
            tokens: { input: 7, output: 1 },
          },
        ],
      }),
    );
    await scanner.scan();
    const byKey = Object.fromEntries(ledger.all().map((r) => [r.key, r]));
    expect(Object.keys(byKey).sort()).toEqual([
      'gemini:main-1:m1',
      'gemini:old-1:o1',
      'gemini:sub-9:s1',
    ]);
    expect(byKey['gemini:main-1:m1']).toMatchObject({
      output: 6,
      input: 6,
      cacheRead: 4,
      project: 'myproj',
    });
    expect(byKey['gemini:sub-9:s1']!.session).toBe('sub-9');
  });

  it('dsh：V0 的 session.jsonl 与 session.v4.jsonl 都能扫到', async () => {
    const { home, ledger, scanner } = mk();
    const u = (seq: number) =>
      `${JSON.stringify({
        type: 'assistant/message',
        seq,
        time: Date.now(),
        data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 } },
      })}\n`;
    const a = path.join(home, '.dsh', 'sessions', 'cwd-a', 'session-aaa');
    const b = path.join(home, '.dsh', 'sessions', 'cwd-b', 'session-bbb');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 'session.jsonl'), u(1));
    fs.writeFileSync(path.join(b, 'session.v4.jsonl'), u(2));
    await scanner.scan();
    expect(ledger.all().filter((r) => r.source === 'dsh')).toHaveLength(2);
    expect(ledger.all()[0]).toMatchObject({ input: 10, cacheRead: 5 });
  });

  it('Codex 分叉 rollout 经扫描器：不重复计入父会话历史', async () => {
    const { home, ledger, scanner } = mk();
    const dir = path.join(home, '.codex', 'sessions', '2026', '10', '14');
    fs.mkdirSync(dir, { recursive: true });
    const fxd = path.join(__dirname, '../../fixtures/history');
    // 夹具时间是 2026-10-14；日志保留窗口内都读，所以直接拷贝
    fs.copyFileSync(
      path.join(fxd, 'codex-fork-parent.jsonl'),
      path.join(dir, 'rollout-parent.jsonl'),
    );
    fs.copyFileSync(
      path.join(fxd, 'codex-fork-child.jsonl'),
      path.join(dir, 'rollout-child.jsonl'),
    );
    await scanner.scan();
    const recs = ledger.all().filter((r) => r.source === 'codex');
    expect(recs.map((r) => r.key).sort()).toEqual([
      'codex:child-0002:3000',
      'codex:parent-0001:1100',
      'codex:parent-0001:2400',
    ]);
  });
});

describe('UsageLogScanner：Qwen / Kimi / OpenCode / Copilot / 各工具 HOME 环境变量', () => {
  const fxd = path.join(__dirname, '../../fixtures/history');
  const setup = (env: NodeJS.ProcessEnv = {}) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-home-'));
    const ledger = new UsageLedger({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-ur-')) });
    const scanner = new UsageLogScanner({
      ledger,
      home,
      env,
      dshHome: path.join(home, '.dsh'),
      retention: () => 'forever',
    });
    return { home, ledger, scanner };
  };
  const put = (file: string, from: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(fxd, from), file);
  };
  type Db = {
    exec(sql: string): void;
    prepare(sql: string): { run(...a: unknown[]): void };
    close(): void;
  };
  const openDb = (file: string): Db => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string) => Db };
    return new DatabaseSync(file);
  };
  const T0 = Date.parse('2026-10-14T10:00:00Z');

  it('Qwen Code：~/.qwen/tmp/<id>/chats/*.jsonl，QWEN_HOME 可改目录；检测到工具', async () => {
    const a = setup();
    put(path.join(a.home, '.qwen', 'tmp', 'pid', 'chats', 'qsess-1.jsonl'), 'qwen-chat.jsonl');
    expect(a.scanner.detected()).toContain('qwen');
    await a.scanner.scan();
    expect(a.ledger.all().map((r) => r.key)).toEqual(['qwen:a-1']);

    const custom = path.join(os.tmpdir(), `nomi-qwen-${Date.now()}`);
    const b = setup({ QWEN_HOME: custom });
    put(path.join(custom, 'tmp', 'pid', 'chats', 'q.jsonl'), 'qwen-chat.jsonl');
    await b.scanner.scan();
    expect(b.ledger.size()).toBe(1);
    // chats 之外的 jsonl 不读
    const c = setup();
    put(path.join(c.home, '.qwen', 'tmp', 'pid', 'other.jsonl'), 'qwen-chat.jsonl');
    await c.scanner.scan();
    expect(c.ledger.size()).toBe(0);
  });

  it('Kimi：旧 kimi-cli 与 Kimi Code 两种目录，KIMI_HOME / KIMI_CODE_HOME 生效，会话 id 取自路径', async () => {
    const a = setup();
    put(
      path.join(a.home, '.kimi', 'sessions', 'wshash', 'sess-legacy', 'wire.jsonl'),
      'kimi-wire-legacy.jsonl',
    );
    put(
      path.join(a.home, '.kimi-code', 'sessions', 'ses_abc', 'agents', 'main', 'wire.jsonl'),
      'kimi-code-wire.jsonl',
    );
    expect(a.scanner.detected()).toContain('kimi');
    await a.scanner.scan();
    const by = Object.fromEntries(a.ledger.all().map((r) => [r.key, r]));
    expect(Object.keys(by).sort()).toEqual([
      'kimi:msg-code-1',
      'kimi:msg-legacy-1',
      'kimi:msg-legacy-2',
      'kimi:step-2',
    ]);
    expect(by['kimi:msg-legacy-1']!.session).toBe('sess-legacy');
    expect(by['kimi:msg-code-1']!.session).toBe('ses_abc');

    const kh = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-kh-'));
    const kc = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-kc-'));
    const b = setup({ KIMI_HOME: kh, KIMI_CODE_HOME: kc });
    put(path.join(kh, 'sessions', 'h', 's1', 'wire.jsonl'), 'kimi-wire-legacy.jsonl');
    put(path.join(kc, 'sessions', 's2', 'agents', 'main', 'wire.jsonl'), 'kimi-code-wire.jsonl');
    await b.scanner.scan();
    expect(b.ledger.size()).toBe(4);
  });

  it('OpenCode：只读 SELECT message 表（assistant）；库没变不重读；新增行下一轮读到；不改库文件', async () => {
    const a = setup();
    const file = path.join(a.home, '.local', 'share', 'opencode', 'opencode.db');
    const db = openDb(file);
    db.exec(
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    );
    const ins = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
    const asst = (tokens: object, extra: object = {}) =>
      JSON.stringify({
        role: 'assistant',
        modelID: 'claude-sonnet-4-5',
        providerID: 'anthropic',
        path: { cwd: '/w/oc' },
        tokens,
        ...extra,
      });
    ins.run(
      'm1',
      's1',
      T0,
      T0 + 5,
      asst({ input: 10, output: 20, reasoning: 5, cache: { read: 300, write: 40 } }),
    );
    ins.run('m2', 's1', T0 + 10, T0 + 10, JSON.stringify({ role: 'user', tokens: { input: 999 } }));
    ins.run(
      'm3',
      's1',
      T0 + 20,
      T0 + 20,
      asst({ input: 0, output: 0, cache: { read: 0, write: 0 } }),
    );
    ins.run('m4', 's1', T0 + 30, T0 + 30, 'not json');
    db.close();
    const before = fs.readFileSync(file);
    expect(a.scanner.detected()).toContain('opencode');
    await a.scanner.scan();
    expect(a.ledger.all()).toHaveLength(1);
    expect(a.ledger.all()[0]).toMatchObject({
      key: 'opencode:m1',
      source: 'opencode',
      provider: 'anthropic',
      input: 10,
      output: 25,
      cacheRead: 300,
      cacheWrite: 40,
      session: 's1',
      project: 'oc',
    });
    expect(fs.readFileSync(file).equals(before)).toBe(true); // 只读：库文件字节不变
    expect((await a.scanner.scan()).added).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    const db2 = openDb(file);
    db2
      .prepare('INSERT INTO message VALUES (?,?,?,?,?)')
      .run(
        'm5',
        's2',
        T0 + 60_000,
        T0 + 60_000,
        asst({ input: 1, output: 2, cache: { read: 0, write: 0 } }),
      );
    db2.close();
    await a.scanner.scan();
    expect(
      a.ledger
        .all()
        .map((r) => r.key)
        .sort(),
    ).toEqual(['opencode:m1', 'opencode:m5']);
  });

  it('OpenCode：OPENCODE_HOME / XDG_DATA_HOME 改目录；库结构不符（没有 message 表）静默跳过', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-oc-'));
    const a = setup({ OPENCODE_HOME: dir });
    const db = openDb(path.join(dir, 'opencode.db'));
    db.exec('CREATE TABLE other (x)');
    db.close();
    await expect(a.scanner.scan()).resolves.toMatchObject({ added: 0 });
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-xdg-'));
    const b = setup({ XDG_DATA_HOME: xdg });
    const d2 = openDb(path.join(xdg, 'opencode', 'opencode.db'));
    d2.exec(
      'CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    );
    d2.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
      'z',
      's',
      T0,
      T0,
      JSON.stringify({ role: 'assistant', modelID: 'm', tokens: { input: 3, output: 4 } }),
    );
    d2.close();
    await b.scanner.scan();
    expect(b.ledger.size()).toBe(1);
  });

  it('Copilot CLI：assistant_usage_events，按 id 增量；COPILOT_HOME 改目录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cp-'));
    const a = setup({ COPILOT_HOME: dir });
    const file = path.join(dir, 'session-store.db');
    const db = openDb(file);
    db.exec(
      'CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, created_at TEXT, secret_note TEXT)',
    );
    const ins = db.prepare(
      'INSERT INTO assistant_usage_events (id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at, secret_note) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    ins.run(1, 'cs', 'gpt-5', 1000, 80, 600, 100, 20, '2026-10-14T10:00:00.000Z', 'x');
    ins.run(2, 'cs', 'gpt-5', 500, 40, 0, 0, 0, '2026-10-14T10:01:00.000Z', 'x');
    db.close();
    expect(a.scanner.detected()).toContain('copilot');
    await a.scanner.scan();
    expect(
      a.ledger.all().map((r) => [r.key, r.input, r.cacheRead, r.cacheWrite, r.output]),
    ).toEqual([
      ['copilot:cs:1', 300, 600, 100, 80],
      ['copilot:cs:2', 500, 0, 0, 40],
    ]);
    await new Promise((r) => setTimeout(r, 30)); // 避开内核时间戳粒度，确保 mtime 变化
    const db2 = openDb(file);
    db2
      .prepare(
        'INSERT INTO assistant_usage_events (id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at) VALUES (3,?,?,?,?,?,?,?)',
      )
      .run('cs', 'gpt-5', 70, 7, 0, 0, '2026-10-14T10:02:00.000Z');
    db2.close();
    await a.scanner.scan();
    expect(a.ledger.size()).toBe(3);
    // 账本里没有任何非记账列的内容
    expect(JSON.stringify(a.ledger.all())).not.toContain('secret');
  });

  it('Gemini：GEMINI_CLI_HOME 指向放 .gemini 的主目录', async () => {
    const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-gh-'));
    const a = setup({ GEMINI_CLI_HOME: gh });
    put(path.join(gh, '.gemini', 'tmp', 'p', 'chats', 'session-1.jsonl'), 'gemini-session.jsonl');
    expect(a.scanner.detected()).toContain('gemini');
    await a.scanner.scan();
    expect(a.ledger.size()).toBe(2);
  });

  it('CLAUDE_CONFIG_DIR / CODEX_HOME 经注入的 env 生效（不再只读 process.env）', async () => {
    const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cd-'));
    const a = setup({ CLAUDE_CONFIG_DIR: cd });
    fs.mkdirSync(path.join(cd, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(cd, 'projects', 'p', 's.jsonl'), asst('msg_env', 3));
    await a.scanner.scan();
    expect(a.ledger.all().map((r) => r.key)).toEqual(['claude:msg_env']);
  });
});
