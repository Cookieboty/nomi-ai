#!/usr/bin/env node
/**
 * zod 契约（packages/contract/src/app）→ JSON Schema → Go 类型 / 过程表 / 未实现桩。
 * 单一真源：packages/contract。生成物在 apps/desktop-go/internal/contract/gen/，勿手改。
 * 用法：pnpm --filter @nomi-ai/contract build && node scripts/go-contract/gen.mjs [--check]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = path.join(root, 'packages/contract');
const req = createRequire(path.join(pkg, 'package.json'));
const { z } = await import(pathToFileURL(req.resolve('zod')).href);
const { appContract } = await import(pathToFileURL(path.join(pkg, 'dist/app/index.js')).href);
const outDir = path.join(root, 'apps/desktop-go/internal/contract/gen');
const check = process.argv.includes('--check');

const pascal = (s) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('') || 'X';
const GO_KEYWORDS = new Set(['Type']);
const toSchema = (sch, io) => z.toJSONSchema(sch, { io, unrepresentable: 'any', target: 'draft-2020-12' });

const decls = [];
const used = new Set();
function uniq(n) {
  let x = n;
  for (let i = 2; used.has(x); i++) x = n + i;
  used.add(x);
  return x;
}

/** 把一个 JSON Schema 节点转成 Go 类型表达式；需要命名的类型（对象 / 枚举）追加到 decls */
function goType(s, name, defs) {
  if (!s || s === true || Object.keys(s).length === 0) return 'any';
  if (s.$ref) {
    const ref = s.$ref.replace(/^#\/(\$defs|definitions)\//, '');
    if (ref === '#') return 'json.RawMessage';
    return defs.names[ref] ?? 'json.RawMessage';
  }
  const alts = s.anyOf ?? s.oneOf;
  if (alts) {
    const nonNull = alts.filter((a) => a.type !== 'null');
    if (nonNull.length === 1) {
      const t = goType(nonNull[0], name, defs);
      return t.startsWith('*') || t.startsWith('[]') || t.startsWith('map[') || t === 'any' || t === 'json.RawMessage' ? t : '*' + t;
    }
    if (nonNull.every((a) => a.const !== undefined && typeof a.const === 'string') || nonNull.every((a) => a.type === 'string')) {
      return 'string';
    }
    return 'json.RawMessage';
  }
  if (s.const !== undefined) return typeof s.const === 'string' ? 'string' : typeof s.const === 'boolean' ? 'bool' : typeof s.const === 'number' ? 'float64' : 'any';
  if (Array.isArray(s.type)) {
    const nn = s.type.filter((t) => t !== 'null');
    if (nn.length === 1) return goType({ ...s, type: nn[0] }, name, defs);
    return 'json.RawMessage';
  }
  switch (s.type) {
    case 'string':
      if (s.enum && s.enum.every((e) => typeof e === 'string')) {
        const n = uniq(name);
        decls.push(
          `// ${n} 枚举：${s.enum.join(' | ')}\ntype ${n} = string\n\nconst (\n${s.enum
            .map((e) => `\t${n}${pascal(e)} ${n} = ${JSON.stringify(e)}`)
            .join('\n')}\n)\n`,
        );
        return n;
      }
      return 'string';
    case 'integer':
      return 'int64';
    case 'number':
      return 'float64';
    case 'boolean':
      return 'bool';
    case 'null':
      return 'any';
    case 'array':
      if (s.prefixItems) return 'json.RawMessage';
      return '[]' + goType(s.items, name + 'Item', defs);
    case 'object': {
      const props = s.properties ?? {};
      const keys = Object.keys(props);
      if (keys.length === 0) {
        if (s.additionalProperties && s.additionalProperties !== true && s.additionalProperties !== false)
          return 'map[string]' + goType(s.additionalProperties, name + 'Value', defs);
        return 'map[string]any';
      }
      const n = uniq(name);
      const required = new Set(s.required ?? []);
      const seen = new Set();
      const fields = keys.map((k) => {
        let f = pascal(k);
        if (/^[0-9]/.test(f)) f = 'F' + f;
        if (GO_KEYWORDS.has(f) && false) f += '_';
        while (seen.has(f)) f += '_';
        seen.add(f);
        let t = goType(props[k], n + pascal(k), defs);
        const opt = !required.has(k);
        if (opt && !/^(\*|\[\]|map\[|any$|json\.RawMessage$)/.test(t)) t = '*' + t;
        const doc = props[k].description ? `\t// ${String(props[k].description).replace(/\s+/g, ' ')}\n` : '';
        return `${doc}\t${f} ${t} \`json:"${k}${opt ? ',omitempty' : ''}"\``;
      });
      decls.push(`type ${n} struct {\n${fields.join('\n')}\n}\n`);
      return n;
    }
    default:
      return 'any';
  }
}

function convert(sch, io, name) {
  const js = toSchema(sch, io);
  const defs = { names: {} };
  for (const [k, d] of Object.entries(js.$defs ?? {})) defs.names[k] = goType(d, name + pascal(k), defs);
  return { js, go: goType(js, name, defs) };
}

const procs = appContract.procedures;
const events = appContract.events;
const names = Object.keys(procs).sort();
const schemaOut = { version: appContract.version, procedures: {}, events: {}, errors: [...appContract.errors] };
const table = [];
const aliases = [];
for (const n of names) {
  const p = procs[n];
  const base = pascal(n);
  const entry = { kind: p.kind, dangerous: !!p.dangerous, surfaces: p.surfaces ? [...p.surfaces] : [] };
  const inp = convert(p.input, 'input', base + 'Input');
  entry.input = inp.js;
  aliases.push(`// ${base}InputT 是 ${n} 的入参\ntype ${base}InputT = ${inp.go}`);
  if (p.kind === 'stream') {
    const c = convert(p.chunk, 'output', base + 'Chunk');
    entry.chunk = c.js;
    aliases.push(`type ${base}ChunkT = ${c.go}`);
  }
  if (p.output) {
    const o = convert(p.output, 'output', base + 'Output');
    entry.output = o.js;
    aliases.push(`type ${base}OutputT = ${o.go}`);
  }
  schemaOut.procedures[n] = entry;
  table.push(
    `\t{Name: ${JSON.stringify(n)}, Kind: ${JSON.stringify(p.kind)}, Dangerous: ${entry.dangerous}, Surfaces: ${
      entry.surfaces.length ? `[]string{${entry.surfaces.map((x) => JSON.stringify(x)).join(', ')}}` : 'nil'
    }},`,
  );
}
for (const e of Object.keys(events).sort()) {
  const c = convert(events[e], 'output', 'Event' + pascal(e));
  schemaOut.events[e] = c.js;
  aliases.push(`type Event${pascal(e)}T = ${c.go}`);
}

const header = '// Code generated by scripts/go-contract/gen.mjs from packages/contract; DO NOT EDIT.\n\n';
const typesGo = `${header}package gen\n\nimport "encoding/json"\n\nvar _ json.RawMessage\n\n${decls.join('\n')}\n${aliases.join('\n')}\n`;
const kinds = names.reduce((a, n) => ((a[procs[n].kind] = (a[procs[n].kind] ?? 0) + 1), a), {});
const procsGo = `${header}package gen

// ContractVersion 与 appContract.version 一致
var ContractVersion = struct{ Major, Minor int }{${appContract.version.major}, ${appContract.version.minor}}

// Procedure 是契约里一个过程的元数据
type Procedure struct {
\tName      string
\tKind      string // query | mutation | stream
\tDangerous bool
\tSurfaces  []string
}

// 合计 ${names.length}：${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' / ')}
var Procedures = []Procedure{
${table.join('\n')}
}

// Events 是契约里的事件名
var Events = []string{
${Object.keys(events).sort().map((e) => `\t${JSON.stringify(e)},`).join('\n')}
}

// Errors 是契约声明的业务错误码
var Errors = []string{${[...appContract.errors].map((e) => JSON.stringify(e)).join(', ')}}
`;

const files = {
  'types_gen.go': typesGo,
  'procedures_gen.go': procsGo,
  'contract.schema.json': JSON.stringify(schemaOut, null, 1) + '\n',
};
mkdirSync(outDir, { recursive: true });
let drift = false;
for (const [f, body] of Object.entries(files)) {
  const p = path.join(outDir, f);
  let content = body;
  if (f.endsWith('.go')) {
    writeFileSync(p + '.tmp', body);
    content = execFileSync('gofmt', [p + '.tmp']).toString();
    execFileSync('rm', [p + '.tmp']);
  }
  const old = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (old !== content) {
    drift = true;
    if (check) console.error(`[go-contract] drift: ${f}`);
    else writeFileSync(p, content);
  }
}
console.log(`[go-contract] ${names.length} procedures, ${Object.keys(events).length} events${check ? (drift ? ' — DRIFT' : ' — up to date') : ''}`);
if (check && drift) process.exit(1);
