#!/usr/bin/env node
/**
 * D-B10-2 golden parity：character-contract 在 Node 上的行为，写到
 * apps/desktop-go/internal/core/charcontract/testdata/*.json，Go 侧 parity_test.go 逐项比对。
 *  - json.json：V8 JSON.parse 的结果 / 报错文本（随机变异的输入）
 *  - schemas.json：zod schema（manifest / persona / mapping / locale）对随机输入的 issues 与输出
 *  - packs.json：整包（虚拟文件表，测试时落盘）的 validatePackDirSync（严格 / lenient）、
 *    loadPackAt 的 reason / downgraded、resolvePersona / personaNames / personaPronoun
 *
 * 用法：pnpm exec tsx scripts/parity/record-character-contract.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const out = join(root, 'apps/desktop-go/internal/core/charcontract/testdata');
mkdirSync(out, { recursive: true });

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261029);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const chance = (p) => rnd() < p;
const int = (n) => Math.floor(rnd() * n);

// ── JSON.parse ───────────────────────────────────────────────────────────
const jsonSeeds = [
  '{"schema":1,"id":"nomi","assets":{"mode":"rive"}}',
  '[1, -2.5e3, true, false, null, "a\\u00e9\\n", {"k": []}]',
  '{\r\n  "a": "b",\n  "c": [0.5, 1E+2, -0]\n}',
  '"\\ud83d\\ude00 \\uD800 x"',
  '{"0":1,"b":2,"1":3,"a":{"10":1,"2":2},"b":9}',
  '  123  ',
  'undefined',
  'NaN',
  '{"__proto__":{"x":1},"constructor":2}',
  '\ufeff{"a":1}',
  '{"中文":"值","emoji":"😀"}',
];
const junk = ["é", "\u00ff", '{', '}', '[', ']', ',', ':', '"', '\\', '-', '.', 'e', '0', '1', 'x', ' ', '\n', '\r', '\t', 'n', 't', 'u', '\u0001', '😀', '中', "'", '+', 'E'];
const jsonCases = [];
const jsonInputs = new Set([
  '', ' ', '{', '[', '{"a"', '{"a":', '{"a":1', '{"a":1,', '[1', '[1,', '[1,]', '{"a":1,}', '01', '-', '-a', '1.', '1.e3', '1e', '1e+',
  '"abc', '"a\\', '"a\\x"', '"\\u12"', '"\\u12G4"', 'tru', 'trux', 'nul', 'falsey', '{a:1}', "{'a':1}", '[1 2]', '{"a" 1}', '{"a":1 "b":2}',
  '"x" "y"', '1 2', 'Infinity', '[object Object]', '{"a":"\u0001"}', '{"aaaaaaaaaaaaaaaaaaaaaaaa": x}', '{"aaaaaaaaaaaaaaaaaaaaaaaa": 1}x',
  'x{"aaaaaaaaaaaaaaaaaaaaaaaa": 1}', '\r\n\r\n  ]', '\n\r\n\rx', '😀😀😀😀😀😀😀😀😀😀😀😀x', '[-]', '[--1]', '[+1]', '{"a":-}', '{"a":.5}',
]);
for (const s of jsonSeeds) jsonInputs.add(s);
while (jsonInputs.size < 1500) {
  let s = pick(jsonSeeds);
  const n = 1 + int(3);
  for (let k = 0; k < n; k++) {
    const at = int(s.length + 1);
    const op = int(4);
    if (op === 0) s = s.slice(0, at) + pick(junk) + s.slice(at);
    else if (op === 1) s = s.slice(0, at) + s.slice(at + 1);
    else if (op === 2) s = s.slice(0, at);
    else s = s.slice(0, at) + pick(junk) + s.slice(at + 1);
  }
  jsonInputs.add(s);
}
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
for (const src of jsonInputs) {
  if (loneSurrogate.test(src)) continue; // Go 字符串放不下孤立代理项
  try {
    jsonCases.push({ src, ok: true, value: JSON.stringify(JSON.parse(src)) ?? null });
  } catch (err) {
    jsonCases.push({ src, ok: false, error: err.message });
  }
}
writeFileSync(join(out, 'json.json'), JSON.stringify(jsonCases, null, 0).replace(/},{/g, '},\n{') + '\n');
console.log(`json: ${jsonCases.length}`);

// ── zod schemas ──────────────────────────────────────────────────────────
const S = await imp('packages/character-contract/src/schemas.ts');
const schemaByName = {
  manifest: S.manifestSchema,
  persona: S.personaSchema,
  mapping: S.mappingSchema,
  locale: S.characterLocaleSchema,
  hitboxRegion: S.hitboxRegionSchema,
  packId: S.packIdSchema,
  layout: S.layoutSchema,
};
const region = () => ({ top: 0.1, bottom: 0.4, left: 0.2, right: 0.8 });
const templates = {
  manifest: () => ({
    schema: 1,
    id: 'nomi-pack',
    contractVersion: 1,
    version: '1.0.0',
    displayName: { zh: '诺米', en: 'Nomi' },
    engines: { nomi: '>=2' },
    assets: { mode: 'sprite', rive: 'a/b.riv', sprite: 'sprite', static: 'static/x.png', voice: 'voice', onboarding: 'onboarding', layout: 'layout', copy: 'copy', extra: 1 },
    rive: { artboard: 'Main', stateMachine: 'SM' },
    defaults: { a: 1, b: [1] },
    capabilities: { riveMotions: ['idle'], spriteActions: ['wave'], expressions: ['happy'], voiceClipIds: ['x'], lipSync: true, blink: false, more: 'x' },
    layout: { window: { width: 300, height: 400 }, hitboxes: { head: region(), hem: region() }, bubbleAnchor: { x: 0.5, y: 0.1 } },
    catalog: { displayName: 'N', description: 'd', author: 'a', tags: ['t'], version: '1', lastUpdated: '2026' },
    extraTop: { z: 1 },
  }),
  persona: () => ({ displayName: '诺米', shortName: '米', systemPromptIdentity: 'You are Nomi', pronoun: '她', addressUser: '你', greetings: ['hi', ' yo '], tips: ['t'] }),
  mapping: () => ({ emotions: { happy: 'smile', ' sad ': ['cry', 'sob'] }, activities: { idle: ['a'] }, gestures: { wave: 'w' } }),
  locale: () => ({ persona: { displayName: 'Nomi', greetings: [] }, wakePhrase: 'hey', lines: { a: 'x', ' b ': '' } }),
  hitboxRegion: region,
  packId: () => 'nomi-pack',
  layout: () => templates.manifest().layout,
};
const atoms = [
  undefined, null, true, false, 0, -1, 1, 0.5, 1.5, 2, 4096, 4097, -0.1, 1e308, 9007199254740993, 1e21, 1e-7, 3.000001,
  '', ' ', '  x  ', 'x', 'rive', 'static', 'sprite', 'head', 'skirt', '/abs', '../up', 'C:/x', 'a/./b', 'a\\b', 'Nomi', 'NOMI', '-x', 'a'.repeat(65), 'a'.repeat(64),
  '\ufeff', '\u0085', '\u00a0x', [], [''], ['a', ' '], ['a', 2], {}, { zh: '' }, { zh: ' 名 ', en: 3 }, { top: 0.5, bottom: 0.5, left: 0, right: 1 }, { '': 1 }, { 1: 'a', b: 'c' },
];
const randAtom = () => structuredClone(pick(atoms));
function mutate(v, depth = 0) {
  if (chance(0.15) || depth > 4) return randAtom();
  if (Array.isArray(v)) {
    const a = v.map((x) => (chance(0.3) ? mutate(x, depth + 1) : x));
    if (chance(0.2)) a.push(randAtom());
    if (chance(0.15)) a.splice(int(a.length + 1), 1);
    return a;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (chance(0.12)) continue; // 删键
      o[chance(0.04) ? pick(['skirt', ' head', '', '7', '__x']) : k] = chance(0.3) ? mutate(x, depth + 1) : x;
    }
    if (chance(0.15)) o[pick(['skirt', 'zz', '3', ' a ', 'head', 'face', 'emotions', 'mode'])] = randAtom();
    return o;
  }
  return chance(0.5) ? randAtom() : v;
}
const schemaCases = [];
for (const name of Object.keys(schemaByName)) {
  const n = name === 'manifest' ? 1500 : 500;
  for (let k = 0; k < n; k++) {
    const input = k === 0 ? templates[name]() : mutate(templates[name]());
    const src = JSON.stringify(input);
    if (src === undefined) continue;
    const r = schemaByName[name].safeParse(JSON.parse(src));
    schemaCases.push({
      schema: name,
      input: src,
      ok: r.success,
      data: r.success ? JSON.stringify(r.data) ?? null : null,
      issues: r.success ? [] : r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message, keys: i.keys ?? null })),
    });
  }
}
writeFileSync(join(out, 'schemas.json'), JSON.stringify(schemaCases).replace(/},{"schema"/g, '},\n{"schema"') + '\n');
console.log(`schemas: ${schemaCases.length} (${schemaCases.filter((c) => c.ok).length} ok)`);

// ── packs：整包用例（基础包 + 差分，落盘到临时目录后跑 validatePackDirSync / loadPackAt）
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const N = await imp('packages/character-contract/src/node.ts');
  const R = await imp('packages/core/src/character/packResolve.ts');
  const listFiles = (dir, base = '') =>
    readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => {
      const rel = base ? `${base}/${e.name}` : e.name;
      return e.isDirectory() ? listFiles(dir, rel) : e.isFile() ? [rel] : [];
    });
  const bases = {};
  for (const name of ['nomi', 'test-dummy']) {
    const dir = join(root, 'characters', name);
    const b = {};
    for (const rel of listFiles(dir)) {
      if (rel.endsWith('.json') || rel.endsWith('.md')) b[rel] = { b64: readFileSync(join(dir, rel)).toString('base64') };
      else b[rel] = { size: Math.min(statSync(join(dir, rel)).size, 4096) };
    }
    bases[name] = b;
  }
  const txt = (s) => ({ b64: Buffer.from(s, 'utf8').toString('base64') });
  const js = (v) => txt(JSON.stringify(v, null, 2) ?? 'null');
  const parsed = (e) => {
    try { return JSON.parse(Buffer.from(e.b64, 'base64').toString('utf8')); } catch { return undefined; }
  };
  const voiceClips = (n) => {
    const ids = (CONTRACT.voice.requiredClipIds ?? []).slice(0, n);
    return ids.map((id, i) => (i % 3 === 0 ? { key: id, file: `${id}.mp3` } : { id, file: chance(0.1) ? `../${id}.mp3` : `${id}.mp3` }));
  };
  const { CONTRACT } = await imp('packages/character-contract/src/contract.ts');
  const corrupt = (e) => {
    const buf = Buffer.from(e.b64, 'base64');
    switch (int(6)) {
      case 0: return { b64: buf.subarray(0, int(buf.length + 1)).toString('base64') };
      case 1: return { b64: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]).toString('base64') };
      case 2: { const c = Buffer.from(buf); if (c.length) c[int(c.length)] = pick([0xff, 0xc3, 0xe2, 0x80, 0xed, 0x7b]); return { b64: c.toString('base64') }; }
      case 3: return txt('');
      case 4: return txt(pick(['null', '[]', '"x"', '1', '{', 'undefined', '{}']));
      default: return { b64: Buffer.concat([buf, Buffer.from(pick([' x', ',', '\u00e9', '\ufeff']))]).toString('base64') };
    }
  };
  const legacyExtras = () => {
    const s = {};
    if (chance(0.4)) s['copy/zh.json'] = js(mutate({ displayName: ' 旧名 ', systemPromptIdentity: '你是旧角色', wakePhrase: ' hi ', lines: { a: 'x', b: 'y' } }));
    if (chance(0.3)) s['copy/en.json'] = js(mutate({ displayName: 'Old', lines: { a: 'x' } }));
    if (chance(0.3)) s['persona/system-prompt.md'] = txt(pick(['\n\n  你是一个助手\n第二行', '', '   \r\n\t\r\nfirst line  ', '\ufeffBOM line']));
    if (chance(0.3)) s['layout/hitboxes.json'] = js(mutate({ regions: { head: region(), skirt: region(), hem: region() }, bubbleAnchor: { x: 0.5, y: 0.1 } }));
    if (chance(0.2)) s['voice/zh/manifest.json'] = js(mutate({ idSchema: pick(['stable-v1', 'v0', undefined]), clips: voiceClips(int(120)) }));
    if (chance(0.1)) s['voice/en/x.mp3'] = { size: 10 };
    if (chance(0.1)) s['.DS_Store'] = { size: 6 };
    if (chance(0.1)) s['rive/character.riv'] = { size: pick([0, 999, 1000, 1001]) };
    return s;
  };
  const packCases = [];
  for (let k = 0; k < 700; k++) {
    const base = k % 3 === 2 ? 'test-dummy' : 'nomi';
    const b = bases[base];
    const del = [];
    const set = {};
    if (k > 1) {
      for (const p of Object.keys(b)) if (chance(p.endsWith('.json') ? 0.06 : 0.015)) del.push(p);
      for (const p of Object.keys(b).filter((p) => p.endsWith('.json'))) {
        if (del.includes(p)) continue;
        if (chance(0.06)) set[p] = corrupt(b[p]);
        else if (chance(p === 'manifest.json' ? 0.5 : 0.2)) {
          const v = parsed(b[p]);
          const m = mutate(v);
          const s = JSON.stringify(m);
          if (s !== undefined) set[p] = txt(s);
        }
      }
      Object.assign(set, legacyExtras());
    }
    packCases.push({ base, del, set });
  }
  packCases.push({ base: 'nomi', del: Object.keys(bases.nomi), set: {} }); // 空目录
  packCases.push({ base: null, del: [], set: {} }); // 目录不存在

  const tmp = mkdtempSync(join(tmpdir(), 'packparity-'));
  const results = [];
  packCases.forEach((c, i) => {
    const dir = join(tmp, String(i));
    if (c.base) {
      mkdirSync(dir, { recursive: true });
      const files = { ...bases[c.base] };
      for (const p of c.del) delete files[p];
      Object.assign(files, c.set);
      for (const [p, e] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), e.b64 !== undefined ? Buffer.from(e.b64, 'base64') : Buffer.alloc(e.size));
      }
    }
    const run = (f) => { try { return f(); } catch (e) { return { thrown: String(e.message) }; } };
    const strict = run(() => N.validatePackDirSync(dir));
    const lenient = run(() => N.validatePackDirSync(dir, { lenient: true }));
    const load = run(() => R.loadPackAt(dir, { lenient: true }));
    const fix = (r) => JSON.stringify(r).split(dir).join('<DIR>');
    results.push({
      ...c,
      strict: fix(strict),
      lenient: fix(lenient),
      load: fix(load.thrown ? load : { ok: load.ok, reason: load.reason ?? null, downgraded: load.downgraded ?? null }),
    });
  });
  rmSync(tmp, { recursive: true, force: true });
  const { gzipSync } = await import('node:zlib');
  writeFileSync(join(out, 'packs.json.gz'), gzipSync(JSON.stringify({ bases, cases: results }) + '\n', { level: 9 }));
  console.log(`packs: ${results.length} (${results.filter((r) => JSON.parse(r.strict).ok).length} strict ok, ${results.filter((r) => JSON.parse(r.lenient).ok).length} lenient ok)`);
}
