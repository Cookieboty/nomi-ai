#!/usr/bin/env node
/**
 * Licence gate (CI):
 *   1. assets — every file under assets-licenses.json `roots` must match an entry whose licence is allow-listed;
 *      model-list.json entries must carry an allow-listed licence and point at existing files;
 *      only Nomi may be bundled; no .vrm ships in packages/renderer/public.
 *   2. deps  — production dependencies (`pnpm licenses list --prod -r --json`) must use allow-listed
 *      SPDX licences, or be a reviewed per-package exception below.
 *
 * Usage: node scripts/check-licenses.mjs [--assets-only|--deps-only]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const errors = [];

// ---------- deps ----------
const DEP_ALLOW = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'Unlicense',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'BlueOak-1.0.0',
  'Zlib',
  'WTFPL',
]);
/**
 * Reviewed exceptions (name patterns, all platform variants): weak-copyleft libraries used unmodified
 * via dynamic linking / separate files.
 */
const DEP_EXCEPTIONS = [
  {
    pattern: /^@img\/sharp-(libvips-|win32-)/,
    why: 'LGPL-3.0-or-later — prebuilt libvips shared library (via sharp), dynamically linked, unmodified',
  },
];
const isException = (name) => DEP_EXCEPTIONS.some((e) => e.pattern.test(name));

export function spdxAllowed(expr, allow) {
  const e = String(expr ?? '')
    .trim()
    .replace(/^\((.*)\)$/, '$1');
  if (!e) return false;
  if (/\bOR\b/.test(e)) return e.split(/\s+OR\s+/).some((p) => spdxAllowed(p, allow));
  if (/\bAND\b/.test(e)) return e.split(/\s+AND\s+/).every((p) => spdxAllowed(p, allow));
  return allow.has(e);
}

function checkDeps() {
  let out;
  const env = { ...process.env };
  // pnpm's Windows executable probes the default user temp path through
  // realpathSync. In restricted sandboxes that path can return EPERM even
  // though the workspace is writable, so keep its transient files local.
  if (process.platform === 'win32') {
    const workspaceTmp = path.join(ROOT, '.tmp', 'pnpm-runtime');
    fs.mkdirSync(workspaceTmp, { recursive: true });
    env.TEMP = workspaceTmp;
    env.TMP = workspaceTmp;
  }
  try {
    out = execFileSync('pnpm', ['licenses', 'list', '--prod', '-r', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    errors.push(`deps: failed to run "pnpm licenses list": ${err.message}`);
    return;
  }
  const byLicense = JSON.parse(out);
  let count = 0;
  for (const [license, pkgs] of Object.entries(byLicense)) {
    for (const pkg of pkgs) {
      count += 1;
      if (spdxAllowed(license, DEP_ALLOW)) continue;
      if (isException(pkg.name)) continue;
      errors.push(
        `deps: ${pkg.name}@${(pkg.versions ?? []).join(',')} has licence "${license}" (not allow-listed)`,
      );
    }
  }
  console.log(`deps: checked ${count} production packages`);
}

// ---------- assets ----------
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

function checkAssets() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets-licenses.json'), 'utf8'));
  const allow = new Set(manifest.allowedLicenses);
  // 经人工审核的非 OSI 许可：必须同时允许商用与再分发（VRM Public License 1.0、VRoid AvatarSample 条款）
  const reviewed = manifest.reviewedLicenses ?? {};
  for (const [id, r] of Object.entries(reviewed)) {
    const need = r.perModelConditions ? r.requires : r.conditions;
    if (
      !r.url?.startsWith('https://') ||
      need?.commercialUse !== true ||
      need?.redistribution !== true
    )
      errors.push(
        `assets: reviewed licence ${id} must have an https url and permit commercialUse + redistribution`,
      );
    else allow.add(id);
  }
  const entries = manifest.assets.map((a) => ({ ...a, re: globToRegExp(a.pattern) }));
  const firstParty = manifest.firstPartyLicense;
  for (const a of entries) {
    // 第一方作品（项目作者所有、保留所有权利）：只允许显式标记 firstParty + owner 的条目
    const isFirstParty = a.license === firstParty && a.firstParty === true && !!a.owner;
    if (a.license === firstParty && !isFirstParty)
      errors.push(`assets: ${a.pattern} uses ${firstParty} but lacks firstParty:true / owner`);
    // 组合许可（如 "CC0-1.0 AND MIT"）：每一项都必须在白名单内
    const parts = String(a.license).split(/\s+AND\s+/);
    if (!isFirstParty && !parts.every((l) => allow.has(l)))
      errors.push(`assets: manifest entry ${a.pattern} uses non-allowed licence ${a.license}`);
    if (!a.author || !a.source)
      errors.push(`assets: manifest entry ${a.pattern} needs author and source`);
  }
  // 动作库：每个片段都要在清单里登记许可，并与 motions.json 一致
  const motionsRel = 'packages/renderer/public/assets/motions/motions.json';
  const motionsEntry = entries.find((a) => a.re.test(motionsRel));
  if (fs.existsSync(path.join(ROOT, motionsRel))) {
    const lib = JSON.parse(fs.readFileSync(path.join(ROOT, motionsRel), 'utf8'));
    const declared = new Map((motionsEntry?.clips ?? []).map((c) => [c.name, c]));
    for (const c of lib.clips ?? []) {
      const d = declared.get(c.name);
      if (!d) errors.push(`assets: motion clip "${c.name}" is not listed in assets-licenses.json`);
      else if (d.license !== c.license || !allow.has(d.license))
        errors.push(
          `assets: motion clip "${c.name}" licence mismatch / not allowed (${c.license})`,
        );
    }
  }
  let files = 0;
  for (const root of manifest.roots) {
    for (const abs of walk(path.join(ROOT, root))) {
      files += 1;
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      if (!entries.some((a) => a.re.test(rel)))
        errors.push(`assets: ${rel} has no licence entry in assets-licenses.json`);
    }
  }

  const listPath = path.join(ROOT, 'packages/renderer/public/assets/models/vrm/model-list.json');
  const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  const listed = new Set();
  for (const m of list.models ?? []) {
    if (!allow.has(m.license))
      errors.push(`assets: model ${m.name} licence "${m.license}" not allow-listed`);
    if (!m.author || !m.source) errors.push(`assets: model ${m.name} needs author and source`);
    for (const key of ['path', 'thumbnail']) {
      if (!m[key]) continue;
      const file = path.join(ROOT, 'packages/renderer/public', m[key]);
      if (!fs.existsSync(file)) errors.push(`assets: model ${m.name} ${key} missing: ${m[key]}`);
      if (key === 'path') listed.add(path.resolve(file));
    }
  }
  // Only Nomi is bundled; every other character comes from the store or a user import.
  for (const m of list.models ?? [])
    if (m.name !== 'nomi') errors.push(`assets: only Nomi may be bundled (found ${m.name})`);
  for (const vrm of walk(path.join(ROOT, 'packages/renderer/public')).filter((f) =>
    f.endsWith('.vrm'),
  )) {
    if (!listed.has(path.resolve(vrm)))
      errors.push(`assets: ${path.basename(vrm)} is not listed in model-list.json`);
  }
  console.log(`assets: checked ${files} files, ${(list.models ?? []).length} models`);
}

if (!args.has('--deps-only')) checkAssets();
if (!args.has('--assets-only')) checkDeps();

if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  console.error(
    `\nLicence check failed (${errors.length} problem(s)). See THIRD_PARTY_NOTICES.md / assets-licenses.json.`,
  );
  process.exit(1);
}
console.log('✔ licence check passed');
