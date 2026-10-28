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

/**
 * 官方角色 Nomi 的人设——全仓库唯一的一份（docs/design/core-host-decoupling.md §10.4）。
 * 形状与角色包相同：`persona` 是主语言（zh）的 persona.json，`personaLocales.<lang>` 覆盖对应语言的字段。
 * `systemPromptIdentity` 只写身份；对话行为的要求（先给结论、结合上下文作答等）由使用方各自追加。
 * 写进 character.generated.json 后由主进程 PersonaService 读取；character:init 导出示例包时也从这里取。
 */
export const OFFICIAL_PERSONA = {
  displayName: '诺米',
  systemPromptIdentity: '你是 Nomi（诺米），住在用户桌面上的 AI 伙伴。',
  greetings: [],
};
export const OFFICIAL_PERSONA_LOCALES = {
  en: {
    displayName: 'Nomi',
    systemPromptIdentity: 'You are Nomi, an AI companion living on the user desktop.',
  },
};
export const OFFICIAL_WAKE_PHRASE = { zh: '你好，诺米', en: 'Hi, Nomi' };

/** Default generated config for official Nomi (zero behavior change). */
export function officialGenerated() {
  return {
    schema: 1,
    id: 'nomi',
    displayName: {
      zh: OFFICIAL_PERSONA.displayName,
      en: OFFICIAL_PERSONA_LOCALES.en.displayName,
    },
    mode: 'rive',
    voice: { voiceHint: 'nomi', rate: 0.92, pitch: 1.1 },
    rive: {
      src: './assets/models/rive/nomi-complete.riv',
      artboard: 'Nomi-full',
      stateMachine: 'NomiFull',
    },
    promptClipBase: './voice/nomi/zh/',
    persona: { ...OFFICIAL_PERSONA, greetings: [...OFFICIAL_PERSONA.greetings] },
    personaLocales: { en: { ...OFFICIAL_PERSONA_LOCALES.en } },
    wakePhrase: { ...OFFICIAL_WAKE_PHRASE },
    spriteManifestPath: './assets/models/sprite/nomi/manifest.json',
  };
}

const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 包里的人设：persona.json 优先，否则从旧 copy/ 与 persona/system-prompt.md 推出（与 character-contract 的迁移一致）。 */
function packPersona(packDir, copyZh, copyEn, zhName, enName) {
  const personaJson = join(packDir, 'persona.json');
  let persona = null;
  if (existsSync(personaJson)) {
    const raw = readJson(personaJson);
    if (nonEmpty(raw?.displayName) && nonEmpty(raw?.systemPromptIdentity)) {
      persona = {
        ...raw,
        greetings: Array.isArray(raw.greetings) ? raw.greetings : [],
      };
    }
  }
  if (!persona) {
    const promptPath = join(packDir, 'persona/system-prompt.md');
    const prompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf8').trim() : '';
    const identity =
      nonEmpty(copyZh.systemPromptIdentity) ||
      nonEmpty(prompt.split('\n').find((l) => l.trim())) ||
      `你是 ${enName}（${zhName}），住在用户桌面上的 AI 伙伴。`;
    persona = {
      displayName: nonEmpty(copyZh.displayName) || zhName,
      systemPromptIdentity: identity,
      greetings: [],
    };
  }
  const personaLocales = {};
  const localeFile = join(packDir, 'locales/en.json');
  const enLocale = existsSync(localeFile) ? readJson(localeFile)?.persona : null;
  const en = {
    displayName: nonEmpty(enLocale?.displayName) || nonEmpty(copyEn.displayName) || enName,
    systemPromptIdentity:
      nonEmpty(enLocale?.systemPromptIdentity) || nonEmpty(copyEn.systemPromptIdentity),
  };
  if (!en.systemPromptIdentity) delete en.systemPromptIdentity;
  personaLocales.en = en;
  return { persona, personaLocales };
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
  const dn = manifest.displayName || {};
  const zhName = typeof dn === 'string' ? dn : dn.zh || manifest.id;
  const enName = typeof dn === 'string' ? dn : dn.en || zhName;
  const { persona, personaLocales } = packPersona(packDir, copyZh, copyEn, zhName, enName);
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
    persona,
    personaLocales,
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
