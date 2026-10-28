/**
 * 角色人设的唯一来源（docs/design/core-host-decoupling.md §10.4）。
 *
 * 来源按顺序取第一个有效的：
 *   1. 当前角色包（CharacterPackService 解析出的目录）：`persona.json`；没有时用旧包字段
 *      （`copy/<lang>.json` 的 `systemPromptIdentity`、`persona/system-prompt.md` 首行、manifest.displayName）；
 *   2. 内置角色包（本次构建携带的包，默认 characters/nomi；官方角色也只是一个普通角色包）；
 *   3. 中性兜底（内置包缺失时，不冒充任何角色）。
 * 再按界面语言取文案：主语言（zh）是 persona 本身，其他语言用 `locales/<lang>.json` 的 persona 覆盖。
 *
 * 文件格式与校验全部来自 `@nomi-ai/character-contract`。本模块不依赖 electron（将随 P3 进入内核）：
 * 语言、日志、读文件都由调用方注入；IPC 见 ./ipc.ts，AI 插件的身份注入见 ./igPlugin.ts。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  CHARACTER_LOCALES,
  PACK_FILES,
  PRIMARY_CHARACTER_LOCALE,
  characterLocaleSchema,
  migrateLegacyCopy,
  migrateLegacyPersona,
  normalizePackPath,
  personaSchema,
  type CharacterLocale,
  type PersonaData,
} from '@nomi-ai/character-contract';
import type { Persona } from '@nomi-ai/types';

export type { Persona };

/** 一个角色的人设数据：主语言人设 + 其他语言的覆盖 */
export interface PersonaBundle {
  characterId: string;
  persona: PersonaData;
  locales: Partial<Record<CharacterLocale, Partial<PersonaData>>>;
}

/** 人设来源：返回 null 表示这一来源没有可用人设（交给下一个来源） */
export interface PersonaSource {
  readonly id: string;
  load(): PersonaBundle | null;
}

export interface PersonaLogger {
  warn(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export interface PersonaServiceOptions {
  /** 按优先级排列；最后一个应是官方来源，保证总能解析出人设 */
  sources: PersonaSource[];
  /** 当前界面语言（如 `zh-CN` / `en`） */
  locale: () => string;
  logger?: PersonaLogger;
}

/** 界面语言 → 角色文案语言（zh* → zh，其余 → en） */
export function characterLocaleOf(uiLocale: string): CharacterLocale {
  const lang = uiLocale.toLowerCase().split(/[-_]/)[0] ?? '';
  if ((CHARACTER_LOCALES as readonly string[]).includes(lang)) return lang as CharacterLocale;
  return lang ? 'en' : PRIMARY_CHARACTER_LOCALE;
}

/** 按界面语言取一份人设 */
export function resolvePersona(bundle: PersonaBundle, uiLocale: string): Persona {
  const lang = characterLocaleOf(uiLocale);
  const override = lang === PRIMARY_CHARACTER_LOCALE ? undefined : bundle.locales[lang];
  const base = bundle.persona;
  const persona: Persona = {
    characterId: bundle.characterId,
    displayName: override?.displayName ?? base.displayName,
    systemPromptIdentity: override?.systemPromptIdentity ?? base.systemPromptIdentity,
    greetings: [...(override?.greetings ?? base.greetings)],
  };
  const addressUser = override?.addressUser ?? base.addressUser;
  if (addressUser) persona.addressUser = addressUser;
  return persona;
}

/**
 * 最后的兜底：内置角色包缺失或损坏（构建错误）时仍能对话，但不冒充任何角色。
 * 只是模型可见的身份段，不是界面文案。
 */
export function neutralPersonaSource(): PersonaSource {
  const bundle: PersonaBundle = {
    characterId: 'none',
    persona: {
      displayName: 'AI',
      systemPromptIdentity: 'You are an AI companion living on the user desktop.',
      greetings: [],
    },
    locales: {},
  };
  return { id: 'neutral', load: () => bundle };
}

/** 当前启用的角色包（CharacterPackService.getResolved() 的子集） */
export interface ActivePack {
  root: string | null;
  manifest: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 角色包的人设：`<包目录>/persona.json`，没有时退回旧包字段。`getPack()` 没有包时返回 null。
 * 文件缺失或无效时返回 null，由下一个来源（官方数据）兜底。
 */
export function packPersonaSource(
  getPack: () => ActivePack | null | undefined,
  opts: {
    id?: string;
    readFile?: (file: string) => string | undefined;
    logger?: PersonaLogger;
  } = {},
): PersonaSource {
  const readFile =
    opts.readFile ??
    ((file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined));
  return {
    id: opts.id ?? 'character-pack',
    load: () => {
      const pack = getPack();
      if (!pack?.root || !isObject(pack.manifest)) return null;
      const manifest = pack.manifest;
      const characterId = typeof manifest.id === 'string' ? manifest.id : '';
      if (!characterId) return null;
      const root = pack.root;
      const text = (rel: string): string | undefined => {
        const norm = normalizePackPath(rel);
        return norm ? readFile(path.join(root, ...norm.split('/'))) : undefined;
      };
      const json = (rel: string): unknown => {
        const t = text(rel);
        if (t === undefined) return undefined;
        try {
          return JSON.parse(t) as unknown;
        } catch (e) {
          opts.logger?.warn(`character pack ${rel} is not valid JSON`, e);
          return undefined;
        }
      };
      const assets = isObject(manifest.assets) ? manifest.assets : {};
      const copyDir =
        (typeof assets.copy === 'string' && normalizePackPath(assets.copy)) ||
        PACK_FILES.legacyCopyDir;

      // 主语言人设：persona.json → 旧字段
      let persona: PersonaData | null = null;
      const rawPersona = json(PACK_FILES.persona);
      if (rawPersona !== undefined) {
        const res = personaSchema.safeParse(rawPersona);
        if (res.success) persona = res.data;
        else opts.logger?.warn('character pack persona.json is invalid', res.error.issues);
      }
      if (!persona) {
        persona = migrateLegacyPersona({
          manifest,
          copy: json(`${copyDir}/${PRIMARY_CHARACTER_LOCALE}.json`),
          systemPrompt: text(PACK_FILES.legacySystemPrompt),
          locale: PRIMARY_CHARACTER_LOCALE,
        });
      }
      if (!persona) {
        opts.logger?.debug?.('character pack has no persona, using next source', root);
        return null;
      }

      // 其他语言：locales/<lang>.json 的 persona → 旧 copy/<lang>.json
      const locales: PersonaBundle['locales'] = {};
      for (const lang of CHARACTER_LOCALES) {
        if (lang === PRIMARY_CHARACTER_LOCALE) continue;
        let raw = json(`${PACK_FILES.localesDir}/${lang}.json`);
        if (raw === undefined) {
          const legacy = json(`${copyDir}/${lang}.json`);
          raw = legacy === undefined ? undefined : migrateLegacyCopy(legacy);
        }
        if (raw === undefined) continue;
        const res = characterLocaleSchema.safeParse(raw);
        if (res.success && res.data.persona) locales[lang] = res.data.persona;
      }
      return { characterId, persona, locales };
    },
  };
}

const samePersona = (a: Persona, b: Persona): boolean => JSON.stringify(a) === JSON.stringify(b);

export class PersonaService {
  private bundle: PersonaBundle;
  private current: Persona;
  private readonly listeners = new Set<(p: Persona) => void>();

  constructor(private readonly opts: PersonaServiceOptions) {
    if (opts.sources.length === 0) throw new Error('PersonaService needs at least one source');
    this.bundle = this.load();
    this.current = resolvePersona(this.bundle, opts.locale());
  }

  /** 当前角色、当前语言下的人设（副本） */
  get(): Persona {
    return { ...this.current, greetings: [...this.current.greetings] };
  }

  /** 人设变化（换角色包 / 换界面语言）回调；返回取消订阅 */
  onChange(fn: (p: Persona) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 重新读取来源（当前角色包变化后调用）；人设有变化才通知 */
  reload(): Persona {
    this.bundle = this.load();
    return this.update();
  }

  /** 界面语言变化后调用；人设有变化才通知 */
  localeChanged(): Persona {
    return this.update();
  }

  private update(): Persona {
    const next = resolvePersona(this.bundle, this.opts.locale());
    if (!samePersona(next, this.current)) {
      this.current = next;
      const snapshot = this.get();
      for (const fn of [...this.listeners]) {
        try {
          fn(snapshot);
        } catch (e) {
          this.opts.logger?.warn('persona listener failed', e);
        }
      }
    }
    return this.get();
  }

  private load(): PersonaBundle {
    for (const src of this.opts.sources) {
      try {
        const bundle = src.load();
        if (bundle) return bundle;
      } catch (e) {
        this.opts.logger?.warn(`persona source "${src.id}" failed`, e);
      }
    }
    throw new Error('no persona source produced a persona');
  }
}

let instance: PersonaService | undefined;

/** 主进程单例（Application 启动时设置）；未设置时返回 undefined */
export function getPersonaService(): PersonaService | undefined {
  return instance;
}

export function setPersonaService(svc: PersonaService | undefined): void {
  instance = svc;
}
