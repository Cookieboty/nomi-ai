#!/usr/bin/env node
/* eslint-disable no-console -- CLI 脚本 */
/**
 * 首屏体积预算检查：读取各窗口 dist/index.html，统计首屏会加载的 JS（入口 + modulepreload）与 CSS，
 * 对照 scripts/bundle-budgets.json。
 *
 *   node scripts/check-bundle-budget.mjs             只报告：超预算时输出 ::warning 注解，退出码 0（CI 默认，不会变红）
 *   node scripts/check-bundle-budget.mjs --strict    超预算 / 命中禁入标记时退出 1
 *   node scripts/check-bundle-budget.mjs --json      输出 JSON
 *
 * 需要先构建（pnpm build）。dist 不存在的窗口会被跳过并提示。
 */
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const asJson = process.argv.includes('--json');

/** 从 index.html 取首屏资源：入口 module script、modulepreload、stylesheet（忽略跨域 / 绝对 URL） */
export function initialAssets(html) {
  const js = [];
  const css = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) js.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (!href) continue;
    if (/\brel="modulepreload"/.test(tag)) js.push(href);
    else if (/\brel="stylesheet"/.test(tag)) css.push(href);
  }
  const local = (u) => !/^(?:[a-z]+:)?\/\//i.test(u);
  return { js: [...new Set(js.filter(local))], css: [...new Set(css.filter(local))] };
}

const kb = (n) => +(n / 1024).toFixed(1);

function measure(distDir, files) {
  let raw = 0;
  let gz = 0;
  const parts = [];
  for (const f of files) {
    const p = resolve(distDir, f);
    if (!existsSync(p)) continue;
    const buf = readFileSync(p);
    raw += statSync(p).size;
    gz += gzipSync(buf).length;
    parts.push({ file: f.replace(/^\.\//, ''), rawKB: kb(statSync(p).size) });
  }
  return { raw, gz, parts };
}

export function checkWindow(name, cfg, rootDir = ROOT) {
  const distDir = join(rootDir, cfg.dist);
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) return { name, skipped: true, problems: [] };
  const { js, css } = initialAssets(readFileSync(indexPath, 'utf8'));
  const jsM = measure(distDir, js);
  const cssM = measure(distDir, css);
  const problems = [];
  const limit = (label, actualKB, maxKB) => {
    if (maxKB != null && actualKB > maxKB)
      problems.push(`${name}: ${label} ${actualKB} KB exceeds budget ${maxKB} KB`);
  };
  limit('initial JS (raw)', kb(jsM.raw), cfg.initialJsRawKB);
  limit('initial JS (gzip)', kb(jsM.gz), cfg.initialJsGzipKB);
  limit('initial CSS (raw)', kb(cssM.raw), cfg.initialCssRawKB);
  for (const { marker, why } of cfg.forbiddenInInitialJs ?? []) {
    for (const f of js) {
      const p = resolve(distDir, f);
      if (existsSync(p) && readFileSync(p, 'utf8').includes(marker))
        problems.push(
          `${name}: initial chunk ${f.replace(/^\.\//, '')} contains forbidden code (${why})`,
        );
    }
  }
  return {
    name,
    skipped: false,
    initialJs: { rawKB: kb(jsM.raw), gzipKB: kb(jsM.gz), chunks: jsM.parts },
    initialCss: { rawKB: kb(cssM.raw) },
    budget: cfg,
    problems,
  };
}

function main() {
  const budgets = JSON.parse(readFileSync(join(ROOT, 'scripts/bundle-budgets.json'), 'utf8'));
  const results = Object.entries(budgets.windows).map(([n, c]) => checkWindow(n, c));
  const problems = results.flatMap((r) => r.problems);
  if (asJson) console.log(JSON.stringify({ results, problems }, null, 2));
  else {
    const rows = [
      '| window | initial JS (raw) | initial JS (gzip) | initial CSS | budget JS raw / gzip | status |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const r of results) {
      if (r.skipped) {
        rows.push(`| ${r.name} | – | – | – | – | skipped (no dist) |`);
        continue;
      }
      rows.push(
        `| ${r.name} | ${r.initialJs.rawKB} KB | ${r.initialJs.gzipKB} KB | ${r.initialCss.rawKB} KB | ${r.budget.initialJsRawKB} / ${r.budget.initialJsGzipKB} KB | ${r.problems.length ? 'over budget' : 'ok'} |`,
      );
    }
    const table = rows.join('\n');
    console.log(table);
    for (const p of problems) console.log(`::warning title=Bundle budget::${p}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### First-paint bundle budget\n\n${table}\n\n${problems.map((p) => `- ${p}`).join('\n')}\n`,
      );
  }
  if (problems.length && strict) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
