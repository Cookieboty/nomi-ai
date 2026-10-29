#!/usr/bin/env node
// Records Node (@ai-sdk/mcp, as used by packages/ai-runtime mcpBridge) against mcp-mock-server.mjs.
// Output: $NOMI_GOLDEN_DIR/mcp-wire.json (or argv[2]) — per scenario: client-visible results + full two-way wire.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../packages/ai-runtime/package.json'));
const mcpDir = path.dirname(require.resolve('@ai-sdk/mcp/package.json'));
const { createMCPClient } = await import(pathToFileURL(path.join(mcpDir, 'dist/index.js')).href);
const { Experimental_StdioMCPTransport } = await import(pathToFileURL(path.join(mcpDir, 'dist/mcp-stdio/index.js')).href);

const MOCK = path.join(here, 'mcp-mock-server.mjs');
const scenarios = JSON.parse(fs.readFileSync(path.join(here, 'mcp-scenarios.json'), 'utf8'));
const out = process.argv[2] ?? path.join(process.env.NOMI_GOLDEN_DIR ?? path.join(here, '../../apps/desktop-go/internal/ai/mcp/testdata'), 'mcp-wire.json');

const errShape = (e) => {
  const o = { name: e?.name, message: e?.message };
  if (e?.code !== undefined) o.code = e.code;
  if (e?.data !== undefined) o.data = e.data;
  if (e?.statusCode !== undefined) o.statusCode = e.statusCode;
  if (e?.responseBody !== undefined) o.responseBody = e.responseBody;
  return o;
};
const normUA = (s) => s.replace(/node\.js\/[0-9.v]+/g, 'node.js/<rt>');
const normWire = (w) => JSON.parse(normUA(JSON.stringify(w)));

let httpPort = 0;
async function startHttp() {
  const p = spawn(process.execPath, [MOCK, 'http'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const port = await new Promise((res) => p.stdout.once('data', (d) => res(JSON.parse(d.toString()).port)));
  return { p, port };
}
const getLog = async () => (await fetch(`http://127.0.0.1:${httpPort}/__log?reset=1`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(sc) {
  const s = sc.server;
  const res = { name: sc.name, results: [] };
  let transport;
  let logFile;
  if (s.transport === 'stdio') {
    logFile = path.join(os.tmpdir(), `mcp-wire-${process.pid}-${sc.name}.jsonl`);
    fs.rmSync(logFile, { force: true });
    const env = { ...(s.env ?? {}), MCP_WIRE_LOG: logFile };
    let command = s.command ?? 'node';
    let args = [MOCK, 'stdio', s.variant ?? 'legacy', ...(s.extraArgs ?? [])];
    if (s.cmdShim) { command = path.join(here, 'mcp-mock.cmd'); args = ['stdio', s.variant, ...(s.extraArgs ?? [])]; }
    if (s.command) args = [];
    transport = new Experimental_StdioMCPTransport({ command, args, env });
  } else {
    await getLog();
    const kind = s.transport === 'sse' ? 'sse' : 'mcp';
    transport = { type: s.transport, url: `http://127.0.0.1:${httpPort}/${s.variant}/${kind}`, headers: s.headers };
  }
  const errors = [];
  let client;
  try {
    client = await createMCPClient({ transport, initializationOptions: { timeout: sc.timeoutMs ?? 30000 } });
    res.results.push({ op: 'connect', ok: true });
  } catch (e) {
    res.results.push({ op: 'connect', error: errShape(e) });
  }
  if (client) {
    for (const st of sc.steps) {
      try {
        if (st.op === 'listTools') {
          const r = await client.listTools({ options: { timeout: sc.timeoutMs ?? 30000 } });
          res.results.push({ op: st.op, value: r });
        } else if (st.op === 'callTool') {
          const r = await client.callTool({ name: st.name, arguments: st.args ?? {} });
          res.results.push({ op: st.op, value: r });
        } else if (st.op === 'close') {
          await client.close();
          res.results.push({ op: st.op, ok: true });
        }
      } catch (e) {
        res.results.push({ op: st.op, error: errShape(e) });
      }
    }
  }
  await sleep(300);
  if (logFile) {
    res.wire = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    fs.rmSync(logFile, { force: true });
  } else {
    res.wire = await getLog();
  }
  res.wire = normWire(res.wire);
  void errors;
  return res;
}

const { p, port } = await startHttp();
httpPort = port;
const all = [];
for (const sc of scenarios) {
  if (sc.windowsOnly && process.platform !== 'win32') continue;
  all.push(await run(sc));
}
p.stdin.end();
p.kill();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ platform: process.platform, scenarios: all }, null, 2) + '\n');
console.log(`mcp: ${all.length} scenarios → ${out}`);
process.exit(0);
