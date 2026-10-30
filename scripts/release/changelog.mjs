#!/usr/bin/env node
/* eslint-disable no-console -- CLI 脚本 */
/**
 * 根目录 CHANGELOG.md 由 .changeset/*.md 生成（应用包在 changesets 中被 ignore，不会产出自己的 CHANGELOG）。
 *
 *   node scripts/release/changelog.mjs            重写 CHANGELOG.md 的 “Unreleased” 段
 *   node scripts/release/changelog.mjs --check    CHANGELOG 与 changesets 不一致时退出 1（CI）
 *   node scripts/release/changelog.mjs --release  把 Unreleased 定版为 apps/desktop-electron 的版本号 + 日期
 *                                                 （由 `pnpm changeset:version` 在 changesets 消费前调用）
 *
 * 每条 changeset 的正文首行按 Conventional Commit 前缀归类（feat / fix / perf / …）。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEADER = `# Changelog

All notable changes to Nomi. Generated from [changesets](.changeset/) by
\`pnpm changelog\` — do not edit the Unreleased section by hand; add a changeset instead.
`;

const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['test', 'Tests'],
  ['ci', 'Build & release'],
  ['build', 'Build & release'],
  ['docs', 'Documentation'],
  ['chore', 'Maintenance'],
];

/** Parse one changeset file → { packages, summary } */
export function parseChangeset(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const packages = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*["']?([^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line);
    if (kv) packages[kv[1].trim()] = kv[2];
  }
  return { packages, summary: m[2].trim() };
}

/** Classify by a Conventional Commit prefix; strips it from the rendered line. */
export function classify(summary) {
  const first = summary.split(/\r?\n/)[0];
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.*)$/.exec(first);
  if (!m) return { section: 'Other', line: first, breaking: false };
  const section = SECTIONS.find(([k]) => k === m[1])?.[1] ?? 'Other';
  const scope = m[2] ? `**${m[2]}:** ` : '';
  return { section, line: `${scope}${m[4]}`, breaking: !!m[3] || /breaking/i.test(first) };
}

export function renderUnreleased(changesets) {
  const groups = new Map();
  for (const { summary, packages } of changesets) {
    const c = classify(summary);
    const pk = Object.entries(packages);
    const suffix = pk.length ? ` (${pk.map(([n, b]) => `\`${n}\` ${b}`).join(', ')})` : '';
    const list = groups.get(c.section) ?? [];
    list.push(`- ${c.breaking ? '**BREAKING** ' : ''}${c.line}${suffix}`);
    groups.set(c.section, list);
  }
  const order = [...new Set(SECTIONS.map(([, s]) => s)), 'Other'];
  let out = '## Unreleased\n';
  if (!changesets.length) return `${out}\n_No pending changesets._\n`;
  for (const s of order) {
    const items = groups.get(s);
    if (items?.length) out += `\n### ${s}\n\n${items.sort().join('\n')}\n`;
  }
  return out;
}

export function readChangesets(dir = join(ROOT, '.changeset')) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => parseChangeset(readFileSync(join(dir, f), 'utf8')))
    .filter(Boolean);
}

/** Replace (or insert) the Unreleased section, keep released history below it. */
export function buildChangelog(existing, unreleased) {
  const body = existing ?? HEADER;
  const start = body.indexOf('## Unreleased');
  if (start < 0) {
    const firstRelease = body.indexOf('\n## ');
    if (firstRelease < 0) return `${body.trimEnd()}\n\n${unreleased}`;
    return `${body.slice(0, firstRelease).trimEnd()}\n\n${unreleased}\n${body.slice(firstRelease + 1)}`;
  }
  const next = body.indexOf('\n## ', start + 1);
  const tail = next < 0 ? '' : `\n${body.slice(next + 1)}`;
  return `${body.slice(0, start)}${unreleased}${tail}`;
}

export function release(text, version, date) {
  return text.replace(
    '## Unreleased',
    `## Unreleased\n\n_No pending changesets._\n\n## ${version} — ${date}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = join(ROOT, 'CHANGELOG.md');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const next = buildChangelog(existing, renderUnreleased(readChangesets()));
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    if (next !== existing) {
      console.error('CHANGELOG.md is out of date — run `pnpm changelog` and commit it.');
      process.exit(1);
    }
    console.log('CHANGELOG.md is up to date.');
  } else if (args.includes('--release')) {
    const v = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop-electron/package.json'), 'utf8'),
    ).version;
    writeFileSync(file, release(next, v, new Date().toISOString().slice(0, 10)));
    console.log(`CHANGELOG.md: Unreleased → ${v}`);
  } else {
    writeFileSync(file, next);
    console.log('CHANGELOG.md updated.');
  }
}
