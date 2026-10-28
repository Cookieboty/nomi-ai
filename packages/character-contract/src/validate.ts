/**
 * validatePack：对照契约校验一个角色包，返回结构化的错误 / 警告与规范化后的数据。
 *
 * 与存储无关：输入是 `PackSource`（文件清单 + 读 JSON / 文本的同步函数），
 * Node 端用 `@nomi-ai/character-contract/node` 的 `readPackDir()` 从目录构造，
 * 浏览器或测试可用 `createPackSource()` 从内存数据构造。
 */
import type { z } from 'zod';

import {
  CHARACTER_CONTRACT_VERSION,
  CHARACTER_LOCALES,
  CONTRACT,
  MAPPING_RESERVED_TARGETS,
  ONBOARDING_FILES,
  PACK_FILES,
  PRIMARY_CHARACTER_LOCALE,
  SEMANTIC_ACTIVITIES,
  SEMANTIC_EMOTIONS,
  SEMANTIC_GESTURES,
  type PackMode,
} from './contract';
import {
  isContractVersionSupported,
  isLegacyMapping,
  migrateLegacyCopy,
  migrateLegacyPersona,
  migrateManifest,
  resolveVoiceClipId,
} from './migrations';
import { joinPackPath, normalizePackPath } from './paths';
import {
  characterLocaleSchema,
  manifestSchema,
  mappingSchema,
  personaSchema,
  type CharacterLocaleData,
  type PackLayout,
  type PackManifest,
  type PackMapping,
  type PersonaData,
} from './schemas';

/** 包的只读视图。路径一律是包内相对路径（`/` 分隔）。 */
export interface PackSource {
  /** 包内全部文件 */
  files: Iterable<string>;
  /** 读 JSON：文件不存在返回 undefined；内容不是合法 JSON 时抛错 */
  readJson(path: string): unknown;
  /** 读文本：文件不存在返回 undefined */
  readText?(path: string): string | undefined;
  /** 文件大小（字节）；拿不到时返回 undefined，相关检查跳过 */
  sizeOf?(path: string): number | undefined;
}

export type PackIssueCode =
  | 'manifest-missing'
  | 'json-invalid'
  | 'schema-invalid'
  | 'contract-version-unsupported'
  | 'asset-missing'
  | 'asset-too-small'
  | 'fallback-asset-missing'
  | 'onboarding-missing'
  | 'sprite-fallback-recommended'
  | 'sprite-thumb-recommended'
  | 'sprite-actions-incomplete'
  | 'voice-manifest-missing'
  | 'voice-id-schema'
  | 'voice-clips-incomplete'
  | 'voice-file-missing'
  | 'voice-not-provided'
  | 'persona-missing'
  | 'persona-legacy'
  | 'persona-greetings-empty'
  | 'locale-missing'
  | 'locale-legacy'
  | 'locale-key-missing'
  | 'mapping-unknown-semantic'
  | 'mapping-target-undeclared'
  | 'mapping-legacy'
  | 'layout-legacy';

export interface PackIssue {
  severity: 'error' | 'warning';
  code: PackIssueCode;
  /** 出问题的包内文件 */
  file: string;
  /** 文件内的字段路径（schema 问题时有） */
  path: Array<string | number>;
  message: string;
}

/** 规范化之后的包：迁移已应用，路径已解析为包内实际存在的文件。 */
export interface NormalizedPack {
  manifest: PackManifest;
  mode: PackMode;
  layout: PackLayout;
  persona: PersonaData | null;
  personaSource: 'persona.json' | 'legacy' | null;
  mapping: PackMapping | null;
  locales: Partial<Record<string, CharacterLocaleData>>;
  assets: {
    rive: string | null;
    spriteManifest: string | null;
    static: string | null;
    onboardingDir: string;
    voiceDir: string;
  };
}

export interface ValidatePackOptions {
  /** 要求语音覆盖契约全部 clip（官方包用）；默认缺失只警告 */
  requireCompleteVoice?: boolean;
  /**
   * 把非结构性问题（`NON_STRUCTURAL_ISSUES`：资源大小、回退资源、语音清单等）降为警告。
   * 运行时覆盖包用，让 2.0.5 能加载的包继续能加载；结构性错误（manifest / schema / 主模式
   * 资源 / onboarding）仍然是错误。
   */
  lenient?: boolean;
}

/**
 * 非结构性检查：包缺了它们运行时仍能工作（回退资源、TTS 等）。
 * `lenient` 时这些错误降为警告。
 */
export const NON_STRUCTURAL_ISSUES: readonly PackIssueCode[] = [
  'asset-too-small',
  'fallback-asset-missing',
  'voice-manifest-missing',
  'voice-clips-incomplete',
];

export interface ValidatePackResult {
  ok: boolean;
  errors: PackIssue[];
  warnings: PackIssue[];
  /** 有错误时为 null */
  pack: NormalizedPack | null;
}

/** rive 文件小于这个字节数视为占位 / 损坏 */
const MIN_RIVE_BYTES = 1000;

type IssueSink = (
  severity: PackIssue['severity'],
  code: PackIssueCode,
  file: string,
  message: string,
  path?: Array<string | number>,
) => void;

function zodIssues(sink: IssueSink, file: string, error: z.ZodError): void {
  for (const issue of error.issues) {
    const path = issue.path.map((p) => (typeof p === 'number' ? p : String(p)));
    sink('error', 'schema-invalid', file, issue.message, path);
  }
}

function readJsonSafe(
  src: PackSource,
  file: string,
  sink: IssueSink,
): { found: boolean; value: unknown } {
  try {
    const value = src.readJson(file);
    return { found: value !== undefined, value };
  } catch (err) {
    sink('error', 'json-invalid', file, err instanceof Error ? err.message : String(err));
    return { found: true, value: undefined };
  }
}

function dirOf(rel: string | undefined, fallback: string): string {
  return (rel && normalizePackPath(rel)) || fallback;
}

/** 静态立绘：声明路径优先（目录时取其下 character.webp），其次约定的 webp / png。 */
function resolveStatic(files: Set<string>, declared: string | undefined): string | null {
  const candidates: Array<string | null> = [];
  if (declared) {
    const d = normalizePackPath(declared);
    if (d) candidates.push(/\.(webp|png)$/i.test(d) ? d : joinPackPath(d, 'character.webp'));
  }
  candidates.push('static/character.webp', 'static/character.png');
  return candidates.find((c): c is string => !!c && files.has(c)) ?? null;
}

function mappingTargets(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

export function validatePack(src: PackSource, opts: ValidatePackOptions = {}): ValidatePackResult {
  const errors: PackIssue[] = [];
  const warnings: PackIssue[] = [];
  const sink: IssueSink = (severity, code, file, message, path = []) => {
    if (severity === 'error' && opts.lenient && NON_STRUCTURAL_ISSUES.includes(code)) {
      severity = 'warning';
    }
    (severity === 'error' ? errors : warnings).push({ severity, code, file, path, message });
  };
  const files = new Set<string>();
  for (const f of src.files) {
    const n = normalizePackPath(f);
    if (n) files.add(n);
  }
  const done = (pack: NormalizedPack | null): ValidatePackResult => ({
    ok: errors.length === 0,
    errors,
    warnings,
    pack: errors.length === 0 ? pack : null,
  });

  // ── manifest ────────────────────────────────────────────────────────────
  const rawManifest = readJsonSafe(src, PACK_FILES.manifest, sink);
  if (!rawManifest.found) {
    sink('error', 'manifest-missing', PACK_FILES.manifest, 'manifest.json is required');
    return done(null);
  }
  if (rawManifest.value === undefined) return done(null);

  const rawAssets = (rawManifest.value as { assets?: { layout?: string } } | null)?.assets;
  const layoutDir = dirOf(rawAssets?.layout, 'layout');
  const legacyHitboxesFile = `${layoutDir}/hitboxes.json`;
  const legacyHitboxes = files.has(legacyHitboxesFile)
    ? readJsonSafe(src, legacyHitboxesFile, sink).value
    : undefined;

  const parsed = manifestSchema.safeParse(migrateManifest(rawManifest.value, { legacyHitboxes }));
  if (!parsed.success) {
    zodIssues(sink, PACK_FILES.manifest, parsed.error);
    return done(null);
  }
  const manifest = parsed.data;
  if (legacyHitboxes !== undefined && !manifest.layout?.hitboxes) {
    // 旧文件存在但没能并入（形状不对）
    sink('warning', 'layout-legacy', legacyHitboxesFile, 'unrecognised legacy hitboxes file');
  } else if (legacyHitboxes !== undefined) {
    sink(
      'warning',
      'layout-legacy',
      legacyHitboxesFile,
      'legacy layout/hitboxes.json — move hitboxes and bubbleAnchor into manifest.layout',
    );
  }
  if (!isContractVersionSupported(manifest.contractVersion)) {
    sink(
      'error',
      'contract-version-unsupported',
      PACK_FILES.manifest,
      `contractVersion ${manifest.contractVersion} is newer than supported ${CHARACTER_CONTRACT_VERSION}`,
      ['contractVersion'],
    );
  }
  const mode = manifest.assets.mode;
  const assets = manifest.assets;

  // ── onboarding ──────────────────────────────────────────────────────────
  const onboardingDir = dirOf(assets.onboarding, 'onboarding');
  for (const f of ONBOARDING_FILES) {
    const rel = `${onboardingDir}/${f}`;
    if (!files.has(rel)) sink('error', 'onboarding-missing', rel, `missing ${rel}`);
  }

  // ── engine assets ───────────────────────────────────────────────────────
  let rive: string | null = null;
  let spriteManifest: string | null = null;
  let staticRel: string | null = null;
  const spriteDir = dirOf(assets.sprite, 'sprite');
  const spriteManifestRel = `${spriteDir}/manifest.json`;
  if (files.has(spriteManifestRel)) spriteManifest = spriteManifestRel;

  if (mode === 'static') {
    staticRel = resolveStatic(files, assets.static);
    if (!staticRel) {
      sink(
        'error',
        'asset-missing',
        assets.static ?? 'static/character.webp',
        'static mode requires static/character.webp (or .png)',
      );
    }
  } else {
    if (mode === 'rive' || assets.rive) {
      const riveRel =
        normalizePackPath(assets.rive ?? 'rive/character.riv') ?? 'rive/character.riv';
      if (!files.has(riveRel)) {
        // 主模式不是 rive 时，rive 只是可选资源
        sink(
          'error',
          mode === 'rive' ? 'asset-missing' : 'fallback-asset-missing',
          riveRel,
          `missing ${riveRel}`,
        );
      } else {
        rive = riveRel;
        const size = src.sizeOf?.(riveRel);
        if (size !== undefined && size <= MIN_RIVE_BYTES) {
          sink('error', 'asset-too-small', riveRel, `rive file too small (${size} bytes)`);
        }
      }
    }
    if (mode === 'sprite' || assets.sprite) {
      if (!spriteManifest) {
        sink(
          'error',
          mode === 'sprite' ? 'asset-missing' : 'fallback-asset-missing',
          spriteManifestRel,
          'sprite/manifest.json required when sprite present',
        );
      } else {
        if (!files.has(`${spriteDir}/thumb.png`)) {
          sink(
            'warning',
            'sprite-thumb-recommended',
            `${spriteDir}/thumb.png`,
            'sprite thumb.png recommended',
          );
        }
        const declared = manifest.capabilities?.spriteActions;
        if (declared && declared.length > 0) {
          const missing = CONTRACT.sprite.actionIds.filter((id) => !declared.includes(id));
          if (missing.length) {
            sink(
              'warning',
              'sprite-actions-incomplete',
              PACK_FILES.manifest,
              `sprite capabilities omit ${missing.length} contract actions (ok if intentional)`,
              ['capabilities', 'spriteActions'],
            );
          }
        }
      }
    } else if (mode === 'rive') {
      sink(
        'warning',
        'sprite-fallback-recommended',
        spriteManifestRel,
        'sprite/ fallback strongly recommended for rive packs',
      );
    }
  }

  // ── voice ───────────────────────────────────────────────────────────────
  const voiceDir = dirOf(assets.voice, 'voice');
  let anyVoice = false;
  for (const locale of CONTRACT.voice.locales) {
    const dir = `${voiceDir}/${locale}`;
    if (![...files].some((f) => f.startsWith(`${dir}/`))) continue;
    anyVoice = true;
    const manPath = `${dir}/manifest.json`;
    const man = readJsonSafe(src, manPath, sink);
    if (!man.found) {
      sink('error', 'voice-manifest-missing', manPath, `${manPath} required when ${dir} present`);
      continue;
    }
    const value = (man.value ?? {}) as {
      idSchema?: string;
      clips?: Array<{ id?: string; key?: string; file?: string }>;
    };
    if (value.idSchema && value.idSchema !== 'stable-v1') {
      sink('warning', 'voice-id-schema', manPath, `unexpected voice idSchema: ${value.idSchema}`);
    }
    const clips = Array.isArray(value.clips) ? value.clips : [];
    const have = new Set<string>();
    for (const c of clips) {
      if (typeof c.id === 'string') have.add(resolveVoiceClipId(c.id));
      if (typeof c.key === 'string') have.add(resolveVoiceClipId(c.key));
    }
    const required = CONTRACT.voice.requiredClipIds;
    const missing = required.filter((id) => !have.has(id));
    if (missing.length) {
      sink(
        opts.requireCompleteVoice ? 'error' : 'warning',
        'voice-clips-incomplete',
        manPath,
        `voice missing ${missing.length}/${required.length} contract clips (e.g. ${missing
          .slice(0, 3)
          .join(', ')})`,
      );
    }
    for (const c of clips) {
      if (typeof c.file !== 'string') continue;
      const rel = joinPackPath(dir, c.file);
      if (!rel || !files.has(rel)) {
        sink(
          'warning',
          'voice-file-missing',
          rel ?? `${dir}/${c.file}`,
          `voice file missing: ${c.file}`,
        );
      }
    }
  }
  if (!anyVoice) {
    sink(
      'warning',
      'voice-not-provided',
      voiceDir,
      `${voiceDir}/${CONTRACT.voice.locales[0] ?? 'zh'} not provided — prompt clips fall back to TTS / silence`,
    );
  }

  // ── locales（角色文案） ────────────────────────────────────────────────
  const locales: Partial<Record<string, CharacterLocaleData>> = {};
  const copyDir = dirOf(assets.copy, PACK_FILES.legacyCopyDir);
  const legacyCopy: Partial<Record<string, unknown>> = {};
  for (const locale of CHARACTER_LOCALES) {
    const file = `${PACK_FILES.localesDir}/${locale}.json`;
    const legacyFile = `${copyDir}/${locale}.json`;
    let raw: unknown;
    let source = file;
    if (files.has(file)) {
      raw = readJsonSafe(src, file, sink).value;
    } else if (files.has(legacyFile)) {
      const legacy = readJsonSafe(src, legacyFile, sink).value;
      legacyCopy[locale] = legacy;
      raw = migrateLegacyCopy(legacy);
      source = legacyFile;
      sink('warning', 'locale-legacy', legacyFile, `legacy ${legacyFile} — move to ${file}`);
    } else {
      sink('warning', 'locale-missing', file, `${file} recommended (character copy)`);
      continue;
    }
    if (raw === undefined) continue;
    const res = characterLocaleSchema.safeParse(raw);
    if (!res.success) zodIssues(sink, source, res.error);
    else locales[locale] = res.data;
  }
  const primaryLines = locales[PRIMARY_CHARACTER_LOCALE]?.lines ?? {};
  for (const locale of CHARACTER_LOCALES) {
    if (locale === PRIMARY_CHARACTER_LOCALE || !locales[locale]) continue;
    const lines = locales[locale]?.lines ?? {};
    const missing = Object.keys(primaryLines).filter((k) => !(k in lines));
    if (missing.length) {
      sink(
        'warning',
        'locale-key-missing',
        `${PACK_FILES.localesDir}/${locale}.json`,
        `${missing.length} line(s) missing translation (e.g. ${missing.slice(0, 3).join(', ')})`,
        ['lines'],
      );
    }
  }

  // ── persona ─────────────────────────────────────────────────────────────
  let persona: PersonaData | null = null;
  let personaSource: NormalizedPack['personaSource'] = null;
  if (files.has(PACK_FILES.persona)) {
    const raw = readJsonSafe(src, PACK_FILES.persona, sink).value;
    if (raw !== undefined) {
      const res = personaSchema.safeParse(raw);
      if (!res.success) zodIssues(sink, PACK_FILES.persona, res.error);
      else {
        persona = res.data;
        personaSource = 'persona.json';
      }
    }
  } else {
    const legacy = migrateLegacyPersona({
      manifest: rawManifest.value,
      copy: legacyCopy[PRIMARY_CHARACTER_LOCALE],
      systemPrompt: files.has(PACK_FILES.legacySystemPrompt)
        ? src.readText?.(PACK_FILES.legacySystemPrompt)
        : undefined,
      locale: PRIMARY_CHARACTER_LOCALE,
    });
    if (legacy) {
      persona = legacy;
      personaSource = 'legacy';
      sink(
        'warning',
        'persona-legacy',
        PACK_FILES.persona,
        'persona derived from legacy copy/ and persona/system-prompt.md — add persona.json',
      );
    } else {
      sink('warning', 'persona-missing', PACK_FILES.persona, 'persona.json recommended');
    }
  }
  if (persona && persona.greetings.length === 0) {
    sink('warning', 'persona-greetings-empty', PACK_FILES.persona, 'persona.greetings is empty', [
      'greetings',
    ]);
  }

  // ── mapping ─────────────────────────────────────────────────────────────
  let mapping: PackMapping | null = null;
  if (files.has(PACK_FILES.mapping)) {
    const raw = readJsonSafe(src, PACK_FILES.mapping, sink).value;
    if (raw !== undefined) {
      const res = mappingSchema.safeParse(raw);
      if (!res.success) zodIssues(sink, PACK_FILES.mapping, res.error);
      else if (isLegacyMapping(res.data, manifest.capabilities?.expressions)) {
        // 2.0.5 模板形状：运行时用引擎默认映射（2.0.5 本来就不读 mapping.json），行为不变
        sink(
          'warning',
          'mapping-legacy',
          PACK_FILES.mapping,
          'mapping.json follows the 2.0.5 template (emotions point at motions); it is ignored ' +
            'and the engine default mapping is used. Map emotions to expressions to use it.',
          ['emotions'],
        );
      } else mapping = res.data;
    }
  }
  if (mapping) {
    const vocab: Record<keyof PackMapping, readonly string[]> = {
      emotions: SEMANTIC_EMOTIONS,
      activities: SEMANTIC_ACTIVITIES,
      gestures: SEMANTIC_GESTURES,
    };
    const caps = manifest.capabilities;
    const motions = new Set([...(caps?.riveMotions ?? []), ...(caps?.spriteActions ?? [])]);
    const expressions = new Set(caps?.expressions ?? []);
    const reserved: readonly string[] = MAPPING_RESERVED_TARGETS;
    for (const section of Object.keys(vocab) as Array<keyof PackMapping>) {
      // 情绪 → 表情，活动 / 手势 → 动作；manifest 没声明对应能力时不检查目标
      const declared = section === 'emotions' ? expressions : motions;
      for (const [name, target] of Object.entries(mapping[section] ?? {})) {
        if (!vocab[section].includes(name)) {
          sink(
            'warning',
            'mapping-unknown-semantic',
            PACK_FILES.mapping,
            `unknown ${section} name "${name}" (ignored by runtime)`,
            [section, name],
          );
        }
        if (declared.size === 0) continue;
        for (const t of mappingTargets(target)) {
          if (!declared.has(t) && !reserved.includes(t)) {
            sink(
              'warning',
              'mapping-target-undeclared',
              PACK_FILES.mapping,
              `"${t}" is not declared in manifest.capabilities`,
              [section, name],
            );
          }
        }
      }
    }
  }

  return done({
    manifest,
    mode,
    layout: manifest.layout ?? {},
    persona,
    personaSource,
    mapping,
    locales,
    assets: { rive, spriteManifest, static: staticRel, onboardingDir, voiceDir },
  });
}

/**
 * 从内存数据构造 PackSource（浏览器与测试用）。
 * 值为字符串时视为文本（`.json` 文件会按 JSON 解析），对象 / 数组视为已解析的 JSON，
 * 其他值（`true`、`Uint8Array` 等）只表示文件存在。
 */
export function createPackSource(
  entries: Record<string, unknown>,
  sizes: Record<string, number> = {},
): PackSource {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(entries)) {
    const n = normalizePackPath(k);
    if (n) map.set(n, v);
  }
  return {
    files: [...map.keys()],
    readJson(path) {
      const n = normalizePackPath(path);
      if (!n || !map.has(n)) return undefined;
      const v = map.get(n);
      if (typeof v === 'string') return JSON.parse(v) as unknown;
      if (typeof v === 'object' && v !== null && !ArrayBuffer.isView(v)) return v;
      throw new Error(`${n} is not JSON`);
    },
    readText(path) {
      const n = normalizePackPath(path);
      const v = n ? map.get(n) : undefined;
      return typeof v === 'string' ? v : undefined;
    },
    sizeOf(path) {
      const n = normalizePackPath(path);
      return n ? sizes[n] : undefined;
    },
  };
}
