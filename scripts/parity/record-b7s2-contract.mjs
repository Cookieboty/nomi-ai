#!/usr/bin/env node
/**
 * 批次 7 服务 b7s2（7）：@nomi-ai/cli-sdk/testing 的 checkPlugin 契约检查 golden
 * （内置插件 × 实现缺陷变体 × 历史夹具变体 + 合成插件）。NOMI_GOLDEN_DIR 优先；CI 由 record-b7-drivers.mjs 链式录制。
 * Usage: node --import tsx scripts/parity/record-b7s2-contract.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
// TS 源码打包装载（不依赖各包 dist）
const { importSources } = await import(
  pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'src-bundle.mjs')).href
);
const { A, B } = await importSources(root, {
  A: path.join(root, 'apps/desktop-electron/internal/cli-sdk/src/testing/index.ts'),
  B: path.join(root, 'apps/desktop-electron/internal/cli-plugins/src/main.ts'),
});
const { checkPlugin } = A;
const { BUILTIN_PLUGINS, BUILTIN_CLI_IDS } = B;
const FIX = path.join(root, 'apps/desktop-electron/internal/cli-plugins/fixtures/history');

function fixturesOf(id) {
  const dir = path.join(FIX, id);
  const out = [];
  for (const version of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    const expect = JSON.parse(fs.readFileSync(path.join(dir, version, 'expect.json'), 'utf8'));
    for (const [file, e] of Object.entries(expect))
      out.push({
        name: `${id}/${version}/${file}`,
        path: `/fixtures/${id}/${version}/${file}`,
        text: fs.readFileSync(path.join(dir, version, file), 'utf8'),
        expect: e,
      });
  }
  return out;
}

// 实现缺陷变体（Go 测试按同名实现同一改动）
const V = {
  none: (i) => i,
  noHistory: (i) => ({ ...i, history: undefined }),
  noHistoryResume: (i) => ({ ...i, history: { ...i.history, resume: undefined } }),
  noHistoryParse: (i) => ({ ...i, history: i.history && { ...i.history, parse: undefined } }),
  noAccounts: (i) => ({ ...i, accounts: undefined }),
  noTerminal: (i) => ({ ...i, terminal: undefined }),
  noProgress: (i) => ({ ...i, progress: undefined }),
  noUsage: (i) => ({ ...i, usage: undefined }),
  noPermissions: (i) => ({ ...i, permissions: undefined }),
  noPlaceholder: (i) => ({ ...i, launch: { ...i.launch, placeholderModel: undefined } }),
  otherPlaceholder: (i) => ({ ...i, launch: { ...i.launch, placeholderModel: 'other' } }),
  supportedDiffer: (i) => ({
    ...i,
    permissions: { ...i.permissions, supported: i.permissions.supported.slice(1) },
  }),
  launchNondet: (i) => {
    let n = 0;
    return {
      ...i,
      permissions: { ...i.permissions, launch: (m) => ({ args: [m, String(n++)], env: {} }) },
    };
  },
  launchArgsDiffer: (i) => ({
    ...i,
    permissions: { ...i.permissions, launch: () => ({ args: ['x'], env: {} }) },
  }),
  modeIdDiffer: (i) => ({ ...i, permissions: { ...i.permissions, modeId: () => 'zzz' } }),
  officialNondet: (i) => {
    let n = 0;
    return {
      ...i,
      launch: {
        ...i.launch,
        official: (c) => {
          const a = i.launch.official(c);
          return { ...a, args: [...a.args, String(n++)] };
        },
      },
    };
  },
  officialSecret: (i) => ({
    ...i,
    launch: {
      ...i.launch,
      official: (c) => {
        const a = i.launch.official(c);
        return {
          ...a,
          args: [...a.args, 'sk-abcdefghijkl', 'ok'],
          env: { ...a.env, K: 'Bearer abcdefgh', G: 'ghp_abcdefghijklmn' },
        };
      },
    },
  }),
  officialNoHome: (i) => ({
    ...i,
    launch: {
      ...i.launch,
      official: (c) => {
        const a = i.launch.official(c);
        const env = { ...a.env };
        if (i.accounts) delete env[i.accounts.homeEnv];
        return { ...a, env };
      },
    },
  }),
  stripMissing: (i) => ({ ...i, accounts: i.accounts && { ...i.accounts, strip: [] } }),
  sharedBad: (i) => ({
    ...i,
    accounts: i.accounts && {
      ...i.accounts,
      shared: [
        { name: '/abs' },
        { name: 'a/../b' },
        { name: 'ok/x' },
        { name: '..\\x' },
        { name: '..x' },
      ],
    },
  }),
  loginEmpty: (i) => ({ ...i, accounts: i.accounts && { ...i.accounts, loginArgs: [] } }),
  officialFilesNondet: (i) => {
    let n = 0;
    return {
      ...i,
      launch: {
        ...i.launch,
        official: (c) => ({
          ...i.launch.official(c),
          files: [{ path: 'f', content: String(n++) }],
        }),
      },
    };
  },
  officialHomeNondet: (i) => {
    let n = 0;
    return {
      ...i,
      launch: {
        ...i.launch,
        official: (c) => ({
          ...i.launch.official(c),
          privateHome: { envVar: 'H', shared: String(n++), keepPrivate: [] },
        }),
      },
    };
  },
  officialThrows: (i) => ({
    ...i,
    launch: {
      ...i.launch,
      official: () => {
        throw new Error('boom');
      },
    },
  }),
  parseThrows: (i) => ({
    ...i,
    history: {
      ...i.history,
      parse: () => {
        throw new Error('kaboom');
      },
    },
  }),
  parseNoMeta: (i) => ({ ...i, history: { ...i.history, parse: () => ({ messages: [1, 2] }) } }),
  parseNoTitle: (i) => ({
    ...i,
    history: { ...i.history, parse: () => ({ meta: {}, messages: [] }) },
  }),
};
// 夹具变体
const F = {
  real: (fx) => fx,
  wrongCount: (fx) =>
    fx.map((f) => ({ ...f, expect: { ...f.expect, messages: (f.expect.messages ?? 0) + 1 } })),
  wrongTitle: (fx) => fx.map((f) => ({ ...f, expect: { ...f.expect, title: 'nope "q"' } })),
  expectError: (fx) => fx.map((f) => ({ ...f, expect: { error: true } })),
  garbage: (fx) => [
    { name: 'garbage.jsonl', text: 'not json\n{', expect: { messages: 0 } },
    { name: 'empty.jsonl', text: '', expect: { error: true } },
    { name: 'nopath.jsonl', text: fx[0].text, expect: { title: 'x' } },
  ],
  none: () => [],
};
const scen = [];
const run = async (name, plugin, o) => {
  let out;
  try {
    out = await checkPlugin(plugin, o);
  } catch (e) {
    out = { threw: String(e?.message ?? e) };
  }
  return out;
};
for (const id of BUILTIN_CLI_IDS) {
  for (const v of Object.keys(V)) {
    const fx = F.real(fixturesOf(id));
    scen.push({
      name: `${id}/${v}`,
      plugin: id,
      variant: v,
      fixtures: fx,
      out: await run('', BUILTIN_PLUGINS[id], { historyFixtures: fx, extend: V[v] }),
    });
  }
  for (const f of Object.keys(F)) {
    const fx = F[f](fixturesOf(id));
    scen.push({
      name: `${id}/fx-${f}`,
      plugin: id,
      variant: 'none',
      fixtures: fx,
      out: await run('', BUILTIN_PLUGINS[id], { historyFixtures: fx }),
    });
  }
  scen.push({
    name: `${id}/fx-none-noParse`,
    plugin: id,
    variant: 'noHistoryParse',
    fixtures: [],
    out: await run('', BUILTIN_PLUGINS[id], { historyFixtures: [], extend: V.noHistoryParse }),
  });
}
// 清单补丁：每个 permissionModes 项设字段（Truthy 语义）
const patches = [
  ['args', false],
  ['args', null],
  ['args', []],
  ['modeId', ''],
  ['modeId', 0],
  ['modeId', null],
];
for (const id of ['claude', 'codex'])
  for (const [k, val] of patches)
    for (const v of ['launchArgsDiffer', 'modeIdDiffer']) {
      const m = structuredClone(BUILTIN_PLUGINS[id].manifest);
      for (const pm of m.capabilities.permissionModes ?? []) pm[k] = val;
      const fx = fixturesOf(id);
      scen.push({
        name: `${id}/patch-${k}=${JSON.stringify(val)}/${v}`,
        plugin: id,
        variant: v,
        patch: { [k]: val },
        fixtures: fx,
        out: await run(
          '',
          { ...BUILTIN_PLUGINS[id], manifest: m },
          { historyFixtures: fx, extend: V[v] },
        ),
      });
    }
const claudeM = BUILTIN_PLUGINS.claude.manifest;
const synth = [
  ['bad-manifest', { manifest: { id: 'Bad!', apiVersion: 2 }, main: BUILTIN_PLUGINS.claude.main }],
  ['bad-manifest-null', { manifest: null, main: BUILTIN_PLUGINS.claude.main }],
  ['no-main', { manifest: claudeM }],
  [
    'main-throws',
    {
      manifest: claudeM,
      main: async () => {
        throw new Error('nope');
      },
    },
  ],
];
for (const [name, p] of synth)
  scen.push({ name, plugin: name, variant: 'none', fixtures: [], out: await run(name, p, {}) });

const outDir =
  process.env.NOMI_GOLDEN_DIR ||
  path.join(root, 'apps/desktop-go/internal/clisdk/contract/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'b7s2-contract.json'),
  `${JSON.stringify({ scenarios: scen }, null, 1)}\n`,
);
console.log(
  `b7s2-contract: ${scen.length} scenarios, ${scen.filter((s) => Array.isArray(s.out) && s.out.length).length} with problems`,
);
