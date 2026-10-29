#!/usr/bin/env node
/**
 * 契约内置守卫 golden（Go 回放：internal/procs/guard_parity_test.go）。
 * 真实 implement(appContract) + createServerSession（线上帧）：每个过程 × {call, stream} ×
 * 调用者 {chat, mascot} × {trusted, untrusted}，外加一个未声明的过程名。处理函数一律抛桩错误，
 * 只记录路由层的结果（NOT_FOUND / BAD_REQUEST / FORBIDDEN 的 code + message + data），其余记 "pass"。
 *
 * Usage: node scripts/parity/record-b7s-guard.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importSources } from './src-bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const TD = path.join(root, 'apps/desktop-go/internal/procs/testdata');
const m = await importSources(root, {
  app: path.join(root, 'packages/contract/src/app/index.ts'),
  router: path.join(root, 'packages/contract/src/router.ts'),
  server: path.join(root, 'packages/contract/src/server.ts'),
  errors: path.join(root, 'packages/contract/src/errors.ts'),
});
const { appContract } = m.app;
const stub = () => {
  throw new m.errors.ContractError('UNAVAILABLE', 'stub');
};
const handlers = {};
for (const [name, def] of Object.entries(appContract.procedures)) {
  handlers[name] =
    def.kind === 'stream'
      ? // eslint-disable-next-line require-yield
        async function* () {
          stub();
        }
      : stub;
}
const router = m.router.implement(appContract, handlers);
const ROUTER_CODES = new Set(['NOT_FOUND', 'BAD_REQUEST', 'FORBIDDEN']);

const names = [...Object.keys(appContract.procedures).sort(), 'nope.unknown'];
const callers = [];
for (const surface of ['chat', 'mascot']) for (const trusted of [true, false]) callers.push({ surface, trusted });
const out = [];
let n = 0;
for (const caller of callers) {
  let resolve;
  const session = m.server.createServerSession(router, {
    caller: { ...caller, id: 'c' },
    send: (f) => resolve?.(f),
    strictSerialize: true,
  });
  for (const name of names) {
    for (const kind of ['call', 'stream']) {
      const id = `r${++n}`;
      const p = new Promise((r) => (resolve = r));
      session.receive({ t: 'req', id, kind, name });
      const f = await p;
      const res = f.t === 'err' && ROUTER_CODES.has(f.error.code) ? f.error : 'pass';
      out.push({ surface: caller.surface, trusted: caller.trusted, name, kind, res });
    }
  }
  session.close();
}
fs.mkdirSync(TD, { recursive: true });
fs.writeFileSync(path.join(TD, 'b7s-guard.json'), JSON.stringify(out, null, 1) + '\n');
const tally = {};
for (const r of out) {
  const k = r.res === 'pass' ? 'pass' : r.res.code;
  tally[k] = (tally[k] ?? 0) + 1;
}
console.log(`b7s-guard: ${out.length} cases`, tally);
