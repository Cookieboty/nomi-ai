#!/usr/bin/env node
/**
 * 诊断追踪 → 回放夹具（见 scripts/traceFixture.ts 与 docs/development/testing.md「网关回放夹具」）。
 *
 *   pnpm -F @nomi-ai/gateway exec tsx scripts/trace-to-fixture.ts <trace.json>... [选项]
 *
 *   --name <名字>        夹具名（只给一个追踪时可用；默认取追踪文件名）
 *   --out <目录>         输出目录（默认 tests/fixtures/replay）
 *   --keep-text          保留对话正文（默认换成占位符）
 *   --synthetic          标记为人工合成
 *   --description <说明> 写进夹具的说明
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { traceToFixture } from './traceFixture';

const here = path.dirname(fileURLToPath(import.meta.url));

function main(argv: string[]): number {
  const files: string[] = [];
  let name: string | undefined;
  let out = path.join(here, '..', 'tests', 'fixtures', 'replay');
  let keepText = false;
  let synthetic = false;
  let description: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--name') name = argv[++i];
    else if (a === '--out') out = path.resolve(argv[++i] ?? out);
    else if (a === '--keep-text') keepText = true;
    else if (a === '--synthetic') synthetic = true;
    else if (a === '--description') description = argv[++i];
    else files.push(a);
  }
  if (!files.length) {
    console.error('usage: trace-to-fixture <trace.json>... [--name n] [--out dir] [--keep-text]');
    return 2;
  }
  if (name && files.length > 1) {
    console.error('--name only works with a single trace file');
    return 2;
  }
  fs.mkdirSync(out, { recursive: true });
  for (const f of files) {
    const fixtureName = (name ?? path.basename(f, '.json')).replace(/[^A-Za-z0-9_-]/g, '_');
    const doc: unknown = JSON.parse(fs.readFileSync(f, 'utf8'));
    const fixture = traceToFixture(doc, { name: fixtureName, keepText, synthetic, description });
    const dest = path.join(out, `${fixtureName}.json`);
    fs.writeFileSync(dest, `${JSON.stringify(fixture, null, 2)}\n`);
    console.info(`wrote ${path.relative(process.cwd(), dest)}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
