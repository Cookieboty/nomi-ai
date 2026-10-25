#!/usr/bin/env node
/**
 * 生成网关的内置模型目录 src/models/catalog.json（docs/design/cli-plugin-architecture.md §6.9.3 第 2 级来源）。
 * 数据来自 models.dev（MIT 许可，https://github.com/sst/models.dev），只保留路由与参数渲染要用的字段。
 * 生成规则在 src/models/buildCatalog.ts（运行时「同步模型数据」用同一个函数），所以先构建本包。
 *
 * 不在普通构建 / 测试里运行（需要联网）：模型更新时手动执行，检查 diff 后提交生成的文件。
 *   pnpm --filter @nomi-ai/gateway build
 *   node packages/gateway/scripts/build-catalog.mjs              # 从 https://models.dev/api.json 拉取
 *   node packages/gateway/scripts/build-catalog.mjs ./api.json   # 用本地下载的文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog } from '../dist/index.js';

const SOURCE = 'https://models.dev/api.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'src', 'models', 'catalog.json');

async function load(arg) {
  if (arg) return JSON.parse(fs.readFileSync(arg, 'utf8'));
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
  return res.json();
}

const { fromFallback, ...doc } = buildCatalog(
  await load(process.argv[2]),
  new Date().toISOString().slice(0, 10),
);
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.info(
  `wrote ${Object.keys(doc.models).length} models (${fromFallback} from openrouter) to ${path.relative(process.cwd(), out)}`,
);
