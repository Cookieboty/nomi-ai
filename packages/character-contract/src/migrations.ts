/**
 * 契约迁移（纯函数）：把旧包的数据形状升级到当前契约，不读文件、不改入参。
 *
 * - `skirt → hem`：命中区改名（v1）
 * - 旧 i18n 语音 key → 稳定 clip id（保留一版别名）
 * - manifest：补 `contractVersion`，顶层 `mode` 挪进 `assets.mode`，`layout/hitboxes.json` 并入 `manifest.layout`
 * - 旧 `copy/{zh,en}.json` + `persona/system-prompt.md` → `persona.json` / `locales/*.json`
 */
import { CHARACTER_CONTRACT_VERSION, LEGACY_HITBOX_ALIAS, VOICE_IDS } from './contract';

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 命中区旧名改为现名（`skirt → hem`）。同时存在新旧名时保留新名。
 * 非对象输入原样返回。
 */
export function migrateHitboxIds<T>(regions: T): T {
  if (!isObject(regions)) return regions;
  const out: Json = { ...regions };
  for (const [legacy, current] of Object.entries(LEGACY_HITBOX_ALIAS)) {
    if (legacy in out) {
      if (!(current in out)) out[current] = out[legacy];
      delete out[legacy];
    }
  }
  return out as T;
}

/**
 * 旧版 `layout/hitboxes.json`（`{ regions, bubbleAnchor }`）→ manifest.layout 的形状。
 * 无法识别时返回 undefined。
 */
export function migrateLegacyHitboxesFile(
  raw: unknown,
): { hitboxes: Json; bubbleAnchor?: unknown } | undefined {
  if (!isObject(raw) || !isObject(raw.regions)) return undefined;
  return {
    hitboxes: migrateHitboxIds(raw.regions),
    ...(raw.bubbleAnchor !== undefined ? { bubbleAnchor: raw.bubbleAnchor } : {}),
  };
}

/** 语音 clip 的旧 i18n key → 稳定 id；已经是稳定 id 或未知 key 时原样返回。 */
export function resolveVoiceClipId(keyOrId: string): string {
  return VOICE_IDS.byLegacyKey[keyOrId] ?? keyOrId;
}

/** 一组 clip id / 旧 key 规范为稳定 id（去重，保持顺序）。 */
export function migrateVoiceClipIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(resolveVoiceClipId))];
}

/**
 * 从 `engines.nomiPack`（例如 `">=1 <2"`）推出契约主版本；推不出时为 1。
 */
function contractVersionFromEngines(engines: unknown): number {
  if (!isObject(engines)) return 1;
  const range = str(engines.nomiPack);
  const m = range?.match(/(\d+)/);
  const n = m ? Number(m[1]) : 1;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export interface ManifestMigrationOptions {
  /** 旧版 `layout/hitboxes.json` 的内容，manifest 未声明 layout.hitboxes 时并入 */
  legacyHitboxes?: unknown;
}

/**
 * manifest 升级到当前契约形状（schema 校验之前调用）。非对象输入原样返回，由 schema 报错。
 */
export function migrateManifest(raw: unknown, opts: ManifestMigrationOptions = {}): unknown {
  if (!isObject(raw)) return raw;
  const m: Json = { ...raw };

  if (m.contractVersion === undefined) m.contractVersion = contractVersionFromEngines(m.engines);

  const assets: Json = isObject(m.assets) ? { ...m.assets } : {};
  if (assets.mode === undefined && typeof m.mode === 'string') assets.mode = m.mode;
  delete m.mode;
  m.assets = assets;

  if (isObject(m.capabilities) && Array.isArray(m.capabilities.voiceClipIds)) {
    const ids = m.capabilities.voiceClipIds.filter((x): x is string => typeof x === 'string');
    m.capabilities = { ...m.capabilities, voiceClipIds: migrateVoiceClipIds(ids) };
  }

  const layout: Json = isObject(m.layout) ? { ...m.layout } : {};
  if (isObject(layout.hitboxes)) layout.hitboxes = migrateHitboxIds(layout.hitboxes);
  const legacy = migrateLegacyHitboxesFile(opts.legacyHitboxes);
  if (legacy) {
    if (layout.hitboxes === undefined) layout.hitboxes = legacy.hitboxes;
    if (layout.bubbleAnchor === undefined && legacy.bubbleAnchor !== undefined) {
      layout.bubbleAnchor = legacy.bubbleAnchor;
    }
  }
  if (Object.keys(layout).length) m.layout = layout;
  else delete m.layout;

  return m;
}

export interface LegacyPersonaInput {
  manifest?: unknown;
  /** 旧 `copy/<主语言>.json` */
  copy?: unknown;
  /** 旧 `persona/system-prompt.md` 全文 */
  systemPrompt?: string;
  /** 主语言，默认 zh */
  locale?: string;
}

/**
 * 旧包（无 persona.json）→ persona.json 的数据。
 * 身份句优先取 copy 的 `systemPromptIdentity`，其次 system-prompt.md 首行；
 * 名字取 copy / manifest.displayName / manifest.id。问候没有旧来源时留空数组，由 validatePack 报警告。
 */
export function migrateLegacyPersona(input: LegacyPersonaInput): {
  displayName: string;
  systemPromptIdentity: string;
  greetings: string[];
} | null {
  const manifest = isObject(input.manifest) ? input.manifest : {};
  const copy = isObject(input.copy) ? input.copy : {};
  const locale = input.locale ?? 'zh';
  const dn = manifest.displayName;
  const manifestName = isObject(dn) ? (str(dn[locale]) ?? str(dn.zh) ?? str(dn.en)) : str(dn);
  const displayName = str(copy.displayName) ?? manifestName ?? str(manifest.id);
  const identity =
    str(copy.systemPromptIdentity) ?? str(input.systemPrompt?.split(/\r?\n/).find((l) => l.trim()));
  if (!displayName || !identity) return null;
  return { displayName, systemPromptIdentity: identity, greetings: [] };
}

/**
 * 旧 `copy/<lang>.json`（`{ displayName, wakePhrase, systemPromptIdentity }`）→ `locales/<lang>.json`。
 */
export function migrateLegacyCopy(copy: unknown): Json {
  if (!isObject(copy)) return {};
  const persona: Json = {};
  const displayName = str(copy.displayName);
  const identity = str(copy.systemPromptIdentity);
  if (displayName) persona.displayName = displayName;
  if (identity) persona.systemPromptIdentity = identity;
  const out: Json = {};
  if (Object.keys(persona).length) out.persona = persona;
  const wake = str(copy.wakePhrase);
  if (wake) out.wakePhrase = wake;
  if (isObject(copy.lines)) out.lines = copy.lines;
  return out;
}

/** 当前应用能否加载声明了该版本的包。 */
export function isContractVersionSupported(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= CHARACTER_CONTRACT_VERSION;
}
