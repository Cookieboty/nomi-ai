#!/usr/bin/env node
/**
 * 生成网关的内置模型目录 src/models/catalog.json（docs/design/cli-plugin-architecture.md §6.9.3 第 2 级来源）。
 * 数据来自 models.dev（MIT 许可，https://github.com/sst/models.dev），只保留路由与参数渲染要用的字段。
 *
 * 不在普通构建 / 测试里运行（需要联网）：模型更新时手动执行，检查 diff 后提交生成的文件。
 *   node packages/gateway/scripts/build-catalog.mjs              # 从 https://models.dev/api.json 拉取
 *   node packages/gateway/scripts/build-catalog.mjs ./api.json   # 用本地下载的文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://models.dev/api.json';
/** 只收模型原厂的条目（同一个模型在中转服务里的条目字段常不全）；靠前的优先 */
const ORIGINS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshotai',
  'zhipuai',
  'alibaba',
  'minimax',
  'mistral',
];
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/**
 * 原厂条目还没收录的新模型（如 deepseek-v4.1-flash 先上了中转、原厂条目滞后）：按 OpenRouter 的条目补，
 * 只补这些原厂前缀下的模型；原厂已有的不覆盖。
 */
const FALLBACK = 'openrouter';
const FALLBACK_VENDORS = [
  'openai',
  'anthropic',
  'google',
  'x-ai',
  'deepseek',
  'moonshotai',
  'z-ai',
  'qwen',
  'minimax',
  'mistralai',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'src', 'models', 'catalog.json');

async function load(arg) {
  if (arg) return JSON.parse(fs.readFileSync(arg, 'utf8'));
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
  return res.json();
}

/** models.dev 的 reasoning_options → 目录里的推理规格 */
function reasoningOf(m) {
  if (!m.reasoning) return undefined;
  const opts = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
  const effort = opts.find((o) => o.type === 'effort');
  const budget = opts.find((o) => o.type === 'budget_tokens');
  const toggle = opts.some((o) => o.type === 'toggle');
  const values = Array.isArray(effort?.values) ? effort.values : [];
  const efforts = values.filter((v) => EFFORTS.includes(v));
  const r = {};
  if (effort && efforts.length) {
    r.control = budget && /^claude/i.test(m.family ?? m.id) ? 'adaptive' : 'effort';
    r.efforts = efforts;
  } else if (budget) r.control = 'budget';
  else if (toggle) r.control = 'toggle';
  else r.control = 'none';
  if (budget && (budget.min || budget.max))
    r.budget = {
      ...(budget.min ? { min: budget.min } : {}),
      ...(budget.max ? { max: budget.max } : {}),
    };
  if (toggle || values.includes('none')) r.canDisable = true;
  const field =
    m.interleaved && typeof m.interleaved === 'object' ? m.interleaved.field : undefined;
  if (field) {
    r.passback = 'required';
    r.passbackField = field;
  }
  return r;
}

function entryOf(m) {
  const input = Array.isArray(m.modalities?.input) ? m.modalities.input : [];
  const e = {
    ...(m.family ? { family: m.family } : {}),
    limits: {
      ...(m.limit?.context ? { context: m.limit.context } : {}),
      // 最大输入（总窗口减去为输出预留的部分）：编程助手按它压缩，比总窗口更准
      ...(m.limit?.input ? { input: m.limit.input } : {}),
      ...(m.limit?.output ? { maxOutput: m.limit.output } : {}),
    },
    input: { images: input.includes('image'), pdf: input.includes('pdf') },
    tools: { calling: Boolean(m.tool_call) },
  };
  const r = reasoningOf(m);
  if (r) e.reasoning = r;
  if (m.temperature === false) e.sampling = { temperature: false };
  return e;
}

const data = await load(process.argv[2]);
const models = {};
for (const pid of ORIGINS) {
  for (const [id, m] of Object.entries(data[pid]?.models ?? {})) {
    if (m.type && m.type !== 'chat') continue;
    const key = id.toLowerCase();
    if (!models[key]) models[key] = entryOf(m);
  }
}

let added = 0;
for (const [id, m] of Object.entries(data[FALLBACK]?.models ?? {})) {
  const i = id.indexOf('/');
  if (i <= 0 || !FALLBACK_VENDORS.includes(id.slice(0, i).replace(/^~/, ''))) continue;
  if (m.type && m.type !== 'chat') continue;
  const key = id.slice(i + 1).toLowerCase();
  if (models[key]) continue;
  models[key] = entryOf(m);
  added++;
}

const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
const doc = {
  version: new Date().toISOString().slice(0, 10),
  source: 'models.dev',
  license: 'MIT',
  models: sorted,
};
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.info(
  `wrote ${Object.keys(sorted).length} models (${added} from ${FALLBACK}) to ${path.relative(process.cwd(), out)}`,
);
