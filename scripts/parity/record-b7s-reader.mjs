#!/usr/bin/env node
/**
 * 批次 7s：codexThreadReader 状态机 golden（假 worker 脚本化事件）。场景（opts + steps）随 golden 一起写出，
 * Go 测试按同一份步骤回放并比对日志。
 * Usage: node --import tsx scripts/parity/record-b7s-reader.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { CodexThreadReader } = await import(
  pathToFileURL(path.join(root, 'apps/desktop-electron/internal/core/src/cli/codexThreadReader.ts'))
    .href
);
const logMod = await import(
  pathToFileURL(path.join(root, 'apps/desktop-electron/internal/core/src/utils/log.ts')).href
);
void logMod;

const R = (id) => [{ id, title: `t-${id}` }];
const S = (name, opts, steps) => ({ name, opts, steps });
const scenarios = [
  S('noSpawn', { spawn: 'null' }, [
    { op: 'read', tag: 'a' },
    { op: 'state' },
    { op: 'read', tag: 'b' },
  ]),
  S('noSpawnLocalErr', { spawn: 'null', localErr: 'boom' }, [
    { op: 'read', tag: 'a' },
    { op: 'state' },
  ]),
  S('spawnThrows', { spawn: 'throw' }, [{ op: 'read', tag: 'a' }, { op: 'state' }]),
  S('ok', { spawn: 'fake', idleMs: 60 }, [
    { op: 'read', tag: 'a' },
    { op: 'state' },
    { op: 'msg', id: 1, ok: true, rows: R('x') },
    { op: 'state' },
    { op: 'read', tag: 'b' },
    { op: 'msg', id: 2, ok: true, rows: [] },
    { op: 'wait', ms: 250 },
    { op: 'state' },
    { op: 'read', tag: 'c' },
    { op: 'msg', id: 3, ok: true, rows: R('y') },
    { op: 'shutdown' },
    { op: 'state' },
  ]),
  S('errReply', { spawn: 'fake' }, [
    { op: 'read', tag: 'a' },
    { op: 'msg', id: 1, ok: false, message: 'no db' },
    { op: 'msg', id: 9, ok: true, rows: [] },
    { op: 'state' },
    { op: 'shutdown' },
  ]),
  S('errorEvent', { spawn: 'fake' }, [
    { op: 'read', tag: 'a' },
    { op: 'read', tag: 'b' },
    { op: 'error', message: 'kaboom' },
    { op: 'state' },
    { op: 'msg', id: 1, ok: true, rows: [] },
    { op: 'read', tag: 'c' },
    { op: 'msg', id: 3, ok: true, rows: R('z') },
    { op: 'shutdown' },
  ]),
  S('threeExits', { spawn: 'fake' }, [
    { op: 'read', tag: 'a' },
    { op: 'exit', code: 1 },
    { op: 'read', tag: 'b' },
    { op: 'exit', code: 2 },
    { op: 'read', tag: 'c' },
    { op: 'exit', code: 3 },
    { op: 'state' },
    { op: 'read', tag: 'd' },
    { op: 'state' },
  ]),
  S('resetCrashes', { spawn: 'fake', maxCrashes: 2 }, [
    { op: 'read', tag: 'a' },
    { op: 'exit', code: 1 },
    { op: 'read', tag: 'b' },
    { op: 'msg', id: 2, ok: true, rows: [] },
    { op: 'read', tag: 'c' },
    { op: 'exit', code: 1 },
    { op: 'state' },
    { op: 'read', tag: 'd' },
    { op: 'error', message: 'e2' },
    { op: 'state' },
  ]),
  S('timeouts', { spawn: 'fake', timeoutMs: 40, maxCrashes: 1 }, [
    { op: 'read', tag: 'a' },
    { op: 'wait', ms: 200 },
    { op: 'state' },
    { op: 'read', tag: 'b' },
    { op: 'wait', ms: 200 },
    { op: 'state' },
    { op: 'msg', id: 2, ok: true, rows: [] },
    { op: 'shutdown' },
  ]),
  S('postThrows', { spawn: 'fakeThrowPost' }, [
    { op: 'read', tag: 'a' },
    { op: 'state' },
    { op: 'wait', ms: 120 },
    { op: 'state' },
  ]),
  S('shutdownPending', { spawn: 'fake' }, [
    { op: 'read', tag: 'a' },
    { op: 'read', tag: 'b' },
    { op: 'shutdown' },
    { op: 'state' },
    { op: 'shutdown' },
  ]),
  S('idleCancelled', { spawn: 'fake', idleMs: 120 }, [
    { op: 'read', tag: 'a' },
    { op: 'msg', id: 1, ok: true, rows: [] },
    { op: 'wait', ms: 30 },
    { op: 'read', tag: 'b' },
    { op: 'wait', ms: 200 },
    { op: 'state' },
    { op: 'msg', id: 2, ok: true, rows: [] },
    { op: 'shutdown' },
  ]),
];

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(sc) {
  const log = [];
  const o = sc.opts;
  let n = 0;
  let cur = null;
  const spawn =
    o.spawn === 'null'
      ? () => null
      : o.spawn === 'throw'
        ? () => {
            throw new Error('no worker');
          }
        : () => {
            const k = ++n;
            log.push(`spawn#${k}`);
            const h = {};
            const w = {
              postMessage(m) {
                log.push(`post#${k}:${m.id}:${m.file}`);
                if (o.spawn === 'fakeThrowPost') throw new Error('DataCloneError');
              },
              on(ev, fn) {
                h[ev] = fn;
              },
              terminate() {
                log.push(`term#${k}`);
              },
              ref() {
                log.push(`ref#${k}`);
              },
              unref() {
                log.push(`unref#${k}`);
              },
              h,
            };
            cur = w;
            return w;
          };
  const r = new CodexThreadReader({
    spawn,
    local: (f) => {
      log.push(`local:${f}`);
      if (o.localErr) throw new Error(o.localErr);
      return R('local');
    },
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}),
    ...(o.maxCrashes !== undefined ? { maxCrashes: o.maxCrashes } : {}),
  });
  const reads = [];
  const flush = async () => {
    await tick();
    for (const x of reads) {
      if (x.done && !x.logged) {
        x.logged = true;
        log.push(x.done);
      }
    }
  };
  for (const st of sc.steps) {
    switch (st.op) {
      case 'read': {
        const x = { tag: st.tag };
        reads.push(x);
        r.read(`/db/${st.tag}.sqlite`).then(
          (rows) => (x.done = `${st.tag}:ok:${JSON.stringify(rows)}`),
          (e) => (x.done = `${st.tag}:err:${e.message}`),
        );
        break;
      }
      case 'msg':
        cur.h.message(
          st.ok
            ? { id: st.id, ok: true, rows: st.rows }
            : { id: st.id, ok: false, message: st.message },
        );
        break;
      case 'error':
        cur.h.error(new Error(st.message));
        break;
      case 'exit':
        cur.h.exit(st.code);
        break;
      case 'wait':
        await sleep(st.ms);
        break;
      case 'shutdown':
        r.shutdown();
        break;
      case 'state':
        log.push(`state:inProc=${r.inProcess}:running=${r.running}`);
        break;
    }
    await flush();
  }
  return log;
}

// log.warn 输出到 console.warn：录制时静音（不进 golden，Go 侧也不比对日志文案）
console.warn = () => {};
const out = [];
for (const sc of scenarios) out.push({ ...sc, log: await run(sc) });
const outDir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'b7s_reader.json'),
  JSON.stringify({ platform: process.platform, scenarios: out }, null, 1) + '\n',
);
console.log(`b7s_reader: ${out.length} scenarios`);
