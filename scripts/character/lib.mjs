import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { CONTRACT_JSON, ROOT, TARGETS } from './paths.mjs';

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function loadContract() {
  return readJson(CONTRACT_JSON);
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/** Recursive copy; replaces destination contents when `clean` is true. */
export function copyTree(src, dest, { clean = false } = {}) {
  if (!existsSync(src)) throw new Error(`missing source: ${src}`);
  if (clean && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  ensureDir(dirname(dest));
  cpSync(src, dest, { recursive: true, force: true });
}

export function copyFile(src, dest) {
  ensureDir(dirname(dest));
  cpSync(src, dest, { force: true });
}

export function listFiles(dir, pred = () => true) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d, base = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, rel);
      else if (pred(rel, p)) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

export function resolvePackDir(input) {
  if (!input) return null;
  const p = resolve(ROOT, input);
  if (!existsSync(p)) throw new Error(`CHARACTER_PACK not found: ${p}`);
  const st = statSync(p);
  if (!st.isDirectory()) throw new Error(`CHARACTER_PACK must be a directory: ${p}`);
  return p;
}

export function readManifest(packDir) {
  const path = join(packDir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`pack missing manifest.json: ${path}`);
  const m = readJson(path);
  if (m.schema !== 1) throw new Error(`unsupported pack schema: ${m.schema}`);
  if (!m.id || typeof m.id !== 'string') throw new Error('manifest.id required');
  return m;
}

export function packMode(manifest) {
  return manifest.assets?.mode || manifest.mode || 'rive';
}

export function rel(path) {
  return relative(ROOT, path).split('\\').join('/');
}

/** Default generated config for official Nomi (zero behavior change). */
export function officialGenerated() {
  return {
    schema: 1,
    id: 'nomi',
    displayName: { zh: '诺米', en: 'Nomi' },
    mode: 'rive',
    voice: { voiceHint: 'nomi', rate: 0.92, pitch: 1.1 },
    rive: {
      src: './assets/models/rive/nomi-complete.riv',
      artboard: 'Nomi-full',
      stateMachine: 'NomiFull',
    },
    promptClipBase: './voice/nomi/zh/',
    systemPromptIdentity: '你是 Nomi（诺米），住在用户桌面上的 AI 伙伴。',
    wakePhrase: { zh: '你好，诺米', en: 'Hi, Nomi' },
    spriteManifestPath: './assets/models/sprite/nomi/manifest.json',
  };
}

/** Read layout/hitboxes.json; normalize skirt→hem. Returns null if missing/invalid. */
export function loadPackHitboxes(packDir, manifest) {
  const layoutRel = manifest?.assets?.layout || 'layout';
  const path = join(packDir, layoutRel, 'hitboxes.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readJson(path);
    if (!raw?.regions || typeof raw.regions !== 'object') return null;
    const regions = { ...raw.regions };
    if (regions.skirt && !regions.hem) {
      regions.hem = regions.skirt;
      delete regions.skirt;
    }
    return {
      regions,
      ...(raw.bubbleAnchor ? { bubbleAnchor: raw.bubbleAnchor } : {}),
    };
  } catch {
    return null;
  }
}

export function generatedFromManifest(manifest, packDir) {
  const mode = packMode(manifest);
  const copyZh = existsSync(join(packDir, 'copy/zh.json'))
    ? readJson(join(packDir, 'copy/zh.json'))
    : {};
  const copyEn = existsSync(join(packDir, 'copy/en.json'))
    ? readJson(join(packDir, 'copy/en.json'))
    : {};
  const personaPath = join(packDir, 'persona/system-prompt.md');
  const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8').trim() : '';
  const dn = manifest.displayName || {};
  const zhName = typeof dn === 'string' ? dn : dn.zh || manifest.id;
  const enName = typeof dn === 'string' ? dn : dn.en || zhName;
  const identity =
    copyZh.systemPromptIdentity ||
    (persona ? persona.split('\n')[0] : `你是 ${enName}（${zhName}），住在用户桌面上的 AI 伙伴。`);
  const rive = {
    src: './assets/models/rive/nomi-complete.riv',
    artboard: manifest.rive?.artboard || 'Nomi-full',
    stateMachine: manifest.rive?.stateMachine || 'NomiFull',
  };
  const out = {
    schema: 1,
    id: manifest.id,
    displayName: { zh: zhName, en: enName },
    mode,
    voice: {
      voiceHint: manifest.defaults?.voiceHint || manifest.id,
      rate: manifest.defaults?.voiceRate ?? 0.92,
      pitch: manifest.defaults?.voicePitch ?? 1.1,
    },
    rive,
    promptClipBase: './voice/nomi/zh/',
    systemPromptIdentity: identity,
    wakePhrase: manifest.defaults?.wakePhrase || {
      zh: copyZh.wakePhrase || `你好，${zhName}`,
      en: copyEn.wakePhrase || `Hi, ${enName}`,
    },
    spriteManifestPath: './assets/models/sprite/nomi/manifest.json',
    staticSrc: mode === 'static' ? './assets/models/static/character.webp' : undefined,
    copy: { zh: copyZh, en: copyEn },
  };
  const hitboxes = loadPackHitboxes(packDir, manifest);
  if (hitboxes) out.hitboxes = hitboxes;
  return out;
}

export { TARGETS, ROOT };
