#!/usr/bin/env node
/**
 * 官方账号 golden（Go 回放：internal/core/cli/accounts/accounts_parity_test.go）。
 * AccountService + AccountLogin：外部 CLI = 沙箱里的 node 脚本（NOMI_<KIND>_BIN），行为由 <kind>.mode.json 决定；
 * inUse / liveProcesses / keychain 注入；输出按原始键序比较，沙箱路径 → <SB>，UUID → <U1>…（首次出现序）。
 *
 * Usage: node --import tsx scripts/parity/record-b7s-accounts.mjs   （仅 Linux 录制）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
if (process.platform !== 'linux') {
  console.log('b7s-accounts: record on linux only; skipped');
  process.exit(0);
}
const T = '@@SB@@';
const TD = path.join(root, 'apps/desktop-go/internal/core/cli/accounts/testdata');
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7s-acct-bin-'));
const KINDS = ['claude', 'codex', 'grok', 'gemini'];
const MOCK = fs.readFileSync(path.join(TD, 'b7s-accounts-cli.mjs'), 'utf8');
for (const k of KINDS) {
  const f = path.join(BIN, `${k}.mjs`);
  fs.writeFileSync(f, MOCK.replaceAll('@@KIND@@', k), { mode: 0o755 });
  process.env[`NOMI_${k.toUpperCase()}_BIN`] = f;
}
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { AccountService, parseAccountKind, precheckMessage } = await imp(
  'apps/desktop-electron/internal/core/src/cli/accounts/AccountService.ts',
);
const { ACCOUNT_KINDS } = await imp(
  'apps/desktop-electron/internal/core/src/cli/accounts/types.ts',
);
const { AccountLogin, isLoginUrl, parseLoginOutput, stripTerminal } = await imp(
  'apps/desktop-electron/internal/core/src/cli/accounts/AccountLogin.ts',
);
const { accountDirFor } = await imp(
  'apps/desktop-electron/internal/core/src/cli/accounts/homes.ts',
);
const { claudeKeychainService, claudeAccountName } = await imp(
  'apps/desktop-electron/internal/core/src/cli/accounts/adapters.ts',
);
const { whenPrivateWritesIdle } = await imp(
  'apps/desktop-electron/internal/core/src/utils/privateFile.ts',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenarios = JSON.parse(fs.readFileSync(path.join(TD, 'b7s-accounts-scenarios.json'), 'utf8'));

async function run(sc) {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7s-acct-'));
  const sub = (v) => JSON.parse(JSON.stringify(v).replaceAll(T, SB.replaceAll('\\', '\\\\')));
  for (const k of KINDS) {
    fs.rmSync(path.join(BIN, `${k}.mode.json`), { force: true });
    fs.rmSync(path.join(BIN, `${k}.log`), { force: true });
  }
  for (const f of sub(sc.files ?? [])) {
    const p = path.join(SB, ...f.p.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (f.text !== undefined) fs.writeFileSync(p, f.text);
  }
  const d0 = sc.deps ?? {};
  let calls = [];
  let events = [];
  const inUse = {};
  let live = d0.live ?? { state: 'free' };
  const ids = [];
  const env = { PATH: process.env.PATH, HOME: `${SB}/home`, USER: 'tester', ...(d0.env ?? {}) };
  const mk = () =>
    new AccountService({
      root: `${SB}/root`,
      logger: {
        info: (m, d) => calls.push(['info', m, d ?? null]),
        warn: (m, d) => calls.push(['warn', m, d ?? null]),
      },
      events: { publish: (e, p) => calls.push(['publish', e, p]) },
      env,
      home: `${SB}/home`,
      platform: d0.platform ?? 'linux',
      keychain: {
        get: async () => null,
        set: async () => {},
        remove: async (s, a) => {
          calls.push(['keychain.remove', s, a]);
        },
      },
      now: () => 1700000000000,
      onDefaultChanged: (k) => calls.push(['defaultChanged', k]),
      inUse: (k, id) => inUse[id] ?? (d0.inUseUndef ? undefined : 0),
      onChanged: () => calls.push(['changed']),
      ...(d0.injectLogout
        ? {
            logout: async (k, e) => {
              calls.push(['logout', k, e[d0.injectLogout] ?? null]);
              if (d0.logoutThrows) throw new Error('logout boom');
            },
          }
        : {}),
      liveProcesses: async (k, dir) => {
        calls.push(['live', k, dir]);
        if (live === 'throw') throw new Error('lsof boom');
        return live;
      },
    });
  let svc = mk();
  let login;
  const mkLogin = () =>
    new AccountLogin({
      accounts: svc,
      emit: (e) => events.push(JSON.parse(JSON.stringify(e))),
      ports: { shell: { openExternal: async (u) => calls.push(['open', u]) } },
      logger: { warn: (m, d) => calls.push(['warn', m, d ?? null]) },
      ...(d0.timeoutMs ? { timeoutMs: d0.timeoutMs } : {}),
    });
  login = mkLogin();
  const ref = (v) => {
    if (typeof v !== 'string') return v;
    let m = /^\$(\d+)$/.exec(v);
    if (m) return ids[+m[1] - 1];
    m = /^\$d(\d+):(\w+)$/.exec(v);
    if (m) return accountDirFor(`${SB}/root`, m[2], ids[+m[1] - 1]);
    return v.replace(/\$d(\d+):(\w+)/g, (_, n, k) => accountDirFor(`${SB}/root`, k, ids[+n - 1]));
  };
  const note = (r) => {
    if (
      r &&
      typeof r === 'object' &&
      typeof r.id === 'string' &&
      /^[0-9a-f-]{36}$/.test(r.id) &&
      !ids.includes(r.id)
    )
      ids.push(r.id);
  };
  const out = [];
  for (const st of sc.steps) {
    const [op, ...raw] = sub(st);
    const a = raw.map(ref);
    let r;
    try {
      switch (op) {
        case 'list':
          r = svc.list(a[0] ?? undefined);
          break;
        case 'create':
          r = svc.create(a[0], a.length > 1 ? a[1] : undefined);
          note(r);
          break;
        case 'rename':
          r = svc.rename(a[0], a[1]);
          break;
        case 'setDefault':
          r = svc.setDefault(a[0], a[1]);
          break;
        case 'defaultId':
          r = svc.defaultId(a[0]);
          break;
        case 'defaultDir':
          r = svc.defaultDir(a[0]);
          break;
        case 'launch':
          r = svc.officialLaunch(a[0], a[1]);
          break;
        case 'resolve':
          r = svc.resolve(a[0], a[1]);
          break;
        case 'identityKey':
          r = svc.identityKey(a[0], a[1]);
          break;
        case 'loginTarget': {
          const x = svc.loginTarget(a[0]);
          r = {
            kind: x.kind,
            dir: x.dir,
            env: Object.fromEntries(a[1].map((k) => [k, x.env[k] ?? null])),
          };
          break;
        }
        case 'refresh':
          r = await svc.refresh(a[0]);
          break;
        case 'refreshAll':
          r = await svc.refreshAll(a[0]);
          break;
        case 'remove':
          r = await svc.remove(a[0], a[1] === undefined ? undefined : { force: a[1] });
          break;
        case 'prepareLogin':
          r = await svc.prepareLogin(a[0]);
          break;
        case 'find':
          r = svc.findByAccountId(a[0], a[1]);
          break;
        case 'note':
          r = svc.noteSession(a[0], a[1], a[2]);
          break;
        case 'noteMany':
          for (let i = 0; i < a[1]; i++) svc.noteSession(a[0], `m${i}`, a[2]);
          break;
        case 'sessionsSummary': {
          const j = JSON.parse(fs.readFileSync(a[0], 'utf8'));
          r = {
            keys: Object.keys(j),
            n: j.sessions.length,
            first: j.sessions[0],
            last: j.sessions.at(-1),
          };
          break;
        }
        // createCore.ts SessionHistoryService 的 accountLabel / sessionAccount 依赖（逐字照抄）
        case 'histLabel': {
          if (a[0] !== 'codex') {
            r = undefined;
            break;
          }
          const x = svc.findByAccountId('codex', a[1]);
          r = x ? (x.identity?.email ?? x.label) : undefined;
          break;
        }
        case 'histSession': {
          if (!ACCOUNT_KINDS.includes(a[0])) {
            r = undefined;
            break;
          }
          const x = svc.sessionAccount(a[0], a[1]);
          r = !x ? undefined : svc.list(a[0]).length > 1 ? x : { id: x.id };
          break;
        }
        case 'sessionAccount':
          r = svc.sessionAccount(a[0], a[1]);
          break;
        case 'broadcast':
          r = svc.broadcastChanged();
          break;
        case 'parseKind':
          r = parseAccountKind(a[0]);
          break;
        case 'precheck':
          r = precheckMessage(a[0]);
          break;
        case 'inUse':
          inUse[a[0]] = a[1];
          break;
        case 'live':
          live = a[0];
          break;
        case 'mode':
          fs.writeFileSync(path.join(BIN, `${a[0]}.mode.json`), JSON.stringify(a[1]));
          break;
        case 'cliLog': {
          const f = path.join(BIN, `${a[0]}.log`);
          r = fs.existsSync(f)
            ? fs
                .readFileSync(f, 'utf8')
                .trim()
                .split('\n')
                .map((l) => JSON.parse(l))
            : [];
          fs.rmSync(f, { force: true });
          break;
        }
        case 'reload':
          svc = mk();
          login = mkLogin();
          break;
        case 'idle':
          await whenPrivateWritesIdle();
          break;
        case 'tick':
          await sleep(a[0] ?? 50);
          break;
        case 'calls':
          r = calls;
          calls = [];
          break;
        case 'write':
          fs.mkdirSync(path.dirname(a[0]), { recursive: true });
          fs.writeFileSync(a[0], a[1]);
          break;
        case 'readBin': {
          const f = path.join(BIN, a[0]);
          r = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
          break;
        }
        case 'read':
          r = fs.existsSync(a[0]) ? fs.readFileSync(a[0], 'utf8') : null;
          break;
        case 'ls':
          r = fs.existsSync(a[0]) ? fs.readdirSync(a[0]).sort() : null;
          break;
        case 'loginStart':
          r = await login.start(a[0], a[1] ?? undefined);
          note(r);
          break;
        case 'input':
          r = login.input(a[0], a[1]);
          break;
        case 'cancel':
          r = login.cancel(a[0]);
          break;
        case 'dispose':
          r = await login.dispose();
          break;
        case 'openUrl':
          r = await login.openUrl(a[0]);
          break;
        case 'wait': {
          const t0 = Date.now();
          while (!events.some((e) => e.state === a[0]) && Date.now() - t0 < 8000) await sleep(10);
          if (!events.some((e) => e.state === a[0])) throw new Error(`timeout waiting ${a[0]}`);
          break;
        }
        case 'events':
          r = events;
          events = [];
          break;
        case 'kcService':
          r = [
            claudeKeychainService({ CLAUDE_CONFIG_DIR: a[0] }, a[0]),
            claudeAccountName({ USER: a[1] }),
          ];
          break;
        case 'isLoginUrl':
          r = a.map((u) => isLoginUrl(u));
          break;
        case 'parseLogin':
          r = a.map((s) => parseLoginOutput(s));
          break;
        case 'strip':
          r = a.map((s) => stripTerminal(s));
          break;
        default:
          throw new Error(`bad op ${op}`);
      }
      out.push(r === undefined ? { undef: true } : { v: r });
    } catch (e) {
      out.push({ err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  }
  await login.dispose();
  await sleep(100);
  await whenPrivateWritesIdle();
  const js = JSON.stringify(SB).slice(1, -1);
  let txt = JSON.stringify(out).replaceAll(js, '<SB>');
  const uu = [];
  txt = txt.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
    if (!uu.includes(u)) uu.push(u);
    return `<U${uu.indexOf(u) + 1}>`;
  });
  txt = txt.replace(/credentials-[0-9a-f]{8}"/g, 'credentials-<H>"');
  txt = txt.replace(/(nomi-[a-z]+(?:-[a-z]+)*-)[A-Za-z0-9]{6}(?=")/g, '$1<R>');
  fs.rmSync(SB, { recursive: true, force: true });
  return { name: sc.name, out: JSON.parse(txt) };
}

const result = [];
for (const sc of scenarios) result.push(await run(sc));
fs.rmSync(BIN, { recursive: true, force: true });
const dir =
  process.env.NOMI_GOLDEN_DIR ||
  path.join(root, 'apps/desktop-go/internal/core/cli/accounts/testdata');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'b7s-accounts.json');
fs.writeFileSync(
  file,
  JSON.stringify({ platform: process.platform, scenarios: result }, null, 1) + '\n',
);
console.log(
  `b7s-accounts: ${result.length} scenarios, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps → ${file}`,
);
process.exit(0);
