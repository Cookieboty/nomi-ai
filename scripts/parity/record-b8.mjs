#!/usr/bin/env node
/**
 * 批次 8 golden 录制：apps/desktop-electron/internal/core 的 schedule / knowledge / memory / local / extensions 纯函数。
 * Go 侧 apps/desktop-go/internal/core/knowledgehandlers/parity_test.go 回放并逐项比对。
 * 时间相关用例固定 TZ=Asia/Shanghai（Go 侧同样设置 time.Local）。
 * Usage: TZ=Asia/Shanghai npx tsx scripts/parity/record-b8.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('run with TZ=Asia/Shanghai');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = (p) =>
  import(pathToFileURL(join(root, 'apps/desktop-electron/internal/core/src', p)).href);
const rec = await core('schedule/recurrence.ts');
const chunk = await core('knowledge/chunk.ts');
const tok = await core('knowledge/tokenize.ts');
const ans = await core('knowledge/answer.ts');
const mcp = await core('extensions/mcpConfig.ts');
const mig = await core('extensions/migrate.ts');
const sp = await core('extensions/skillPack.ts');
const ep = await core('memory/episodes.ts');
const llm = await core('local/llmCatalog.ts');

const cases = [];
const add = (fn, args, out) => cases.push({ fn, args, out: out === undefined ? null : out });

const T0 = new Date(2026, 9, 29, 9, 30).getTime(); // 周四
const repeats = [
  { kind: 'daily' },
  { kind: 'weekdays' },
  { kind: 'weekly', days: [1, 3] },
  { kind: 'weekly', days: [0] },
  { kind: 'monthly' },
  { kind: 'interval', minutes: 45 },
];
const anchors = [
  T0,
  new Date(2026, 0, 31, 8, 0).getTime(),
  new Date(2026, 1, 28, 23, 59).getTime(),
];
for (const r of repeats) {
  add('describeRepeat', [r], rec.describeRepeat(r));
  for (const a of anchors)
    for (const d of [0, 60_000, 86_400_000 * 3, 86_400_000 * 40])
      add('nextOccurrence', [r, a, a + d], rec.nextOccurrence(r, a, a + d));
  for (const t of ['07:00', '09:30', '23:59', '00:00'])
    add('firstRun', [t, r, T0], rec.firstRun(t, r, T0));
}
for (const raw of [
  null,
  1,
  { kind: 'x' },
  { kind: 'weekly', days: [9, 1, 1, 3] },
  { kind: 'weekly', days: [] },
  { kind: 'interval', minutes: 1 },
  { kind: 'interval', minutes: 99999 },
  { kind: 'monthly' },
])
  add('sanitizeRepeat', [raw], rec.sanitizeRepeat(raw));
for (const q of [
  { enabled: true, start: '22:00', end: '07:00' },
  { enabled: true, start: '12:00', end: '13:30' },
  { enabled: false, start: '00:00', end: '23:59' },
])
  for (const h of [0, 6, 7, 12, 13, 22, 23]) {
    const at = new Date(2026, 9, 29, h, 15).getTime();
    add('inQuiet', [q, at], rec.inQuiet(q, at));
    add('quietEndsAt', [q, at], rec.quietEndsAt(q, at));
  }

const texts = [
  '',
  'hello world',
  '第一段。\n\n第二段很长'.repeat(120),
  'a'.repeat(2000),
  'Para one.\n\nPara two. '.repeat(90),
  '😀 emoji '.repeat(300),
];
for (const t of texts)
  for (const [s, o] of [
    [800, 120],
    [200, 40],
  ])
    add('chunkText', [t, s, o, 0], chunk.chunkText(t, s, o));
add(
  'chunkPages',
  [['p1 text '.repeat(200), '', 'p3']],
  chunk.chunkPages(['p1 text '.repeat(200), '', 'p3']),
);
for (const t of [
  'Hello, World! hello',
  '机器学习是人工智能的分支',
  'GPT-4o 和 llama.cpp 的 v1.2 版本',
  'the a an of 的 了',
  'ÉCOLE café naïve',
  '',
])
  add('tokenize', [t], tok.tokenize(t));
for (const [a, m] of [
  ['见 [1] 和 [3][2]，还有 [9]', 5],
  ['none', 3],
  ['[2] [2] [1]', 2],
])
  add('citedNumbers', [a, m], ans.citedNumbers(a, m));

for (const [n, taken] of [
  ['My Server', []],
  ['My Server', ['my-server']],
  ['文件系统', []],
  ['', []],
  ['a--b__c', ['a-b-c']],
])
  add('slugId', [n, taken], mcp.slugId(n, new Set(taken)));
for (const v of [
  'sk-abcdef1234567890abcd',
  'hello',
  'ghp_' + 'x'.repeat(36),
  'Bearer abc.def.ghi',
  '12345',
  '${TOKEN}',
])
  add('isSecretValue', [v], mcp.isSecretValue(v));
for (const u of [
  'https://user:pass@host.com/x?token=1',
  'http://host/a',
  'not a url',
  'https://h/?api_key=k&x=1',
])
  add('stripUrlCredentials', [u], mcp.stripUrlCredentials(u));
for (const n of ['My Skill', 'pdf_tools', '中文技能', '--x--', 'A'.repeat(80)]) {
  add('nomiSkillName', [n], mig.nomiSkillName(n));
  add('validSkillName', [n], sp.validSkillName(n));
}
for (const [a, b] of [
  ['我喜欢猫', '我 喜欢 猫！'],
  ['likes coffee', 'Likes coffee.'],
  ['住在上海', '住在北京'],
]) {
  add('normFact', [a], ep.normFact(a));
  add('isDuplicateFact', [a, b], ep.isDuplicateFact(a, b));
}
for (const r of [
  '{"title":"t","summary":"s","facts":[{"kind":"preference","text":"x"}]}',
  '```json\n{"title":"t","summary":"s"}\n```',
  'garbage',
  '{"summary":""}',
])
  add('parseSummary', [r], ep.parseSummary(r));

for (const gb of [4, 8, 12, 16, 24, 32, 64]) {
  add('recommend', [gb], llm.recommend(gb).id);
  for (const m of llm.LOCAL_LLMS) add('fitLevel', [m.id, gb], llm.fitLevel(m, gb));
}
add(
  'serverArgs',
  ['/m.gguf', 8080, 4096, 0],
  llm.serverArgs({ model: '/m.gguf', port: 8080, ctx: 4096 }),
);
add(
  'serverArgs',
  ['/m.gguf', 9, 2048, 6],
  llm.serverArgs({ model: '/m.gguf', port: 9, ctx: 2048, threads: 6 }),
);

const out = join(root, 'apps/desktop-go/internal/core/knowledgehandlers/testdata/parity-b8.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(cases, null, 1) + '\n');
console.log(`[parity-b8] ${cases.length} cases → ${out}`);
