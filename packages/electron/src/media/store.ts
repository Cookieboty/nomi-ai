/**
 * 生图配置存储（主进程）：只存图片模型标记与偏好，不存供应商与 Key。
 * 供应商、Key、地址、启用开关全部来自 Nomi 已有的第三方供应商配置（网关 store.json），经 ProviderSource 读取；
 * 图片模型 = 打包规则识别 + 用户在供应商设置里的标记（见 @nomi-ai/gateway/media providers.ts）。
 * 文件：userData/media/config.json（0600 原子写）。
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_MEDIA_PREFS,
  getImageSpec,
  imageBaseURL,
  imageBindings,
  isBindingUsable,
  migrateParams,
  reconcileChoice,
  type ImageMark,
  type MediaModelChoice,
  type MediaParams,
  type MediaPrefs,
  type ProviderAvailability,
  type ProviderBinding,
  type SharedProvider,
} from '@nomi-ai/gateway/media';

import { ensurePrivateDir, writePrivateFileAtomic } from '../utils/privateFile';

/** 共用供应商来源（网关）。Key 只在主进程里取，绝不进渲染层 */
export interface ProviderSource {
  list(): SharedProvider[];
  /** 该供应商可用的明文 Key；没有返回空串 */
  apiKey(id: string): string;
}

/** 渲染层看到的供应商（不含 Key） */
export interface MediaProviderView {
  id: string;
  name: string;
  presetId?: string;
  enabled: boolean;
  hasKey: boolean;
}

export interface MediaConfig {
  version: 2;
  marks: ImageMark[];
  prefs: MediaPrefs;
}

/** 偏好被自动调整（默认供应商被停用等）时产生的通知 */
export interface ChoiceChange {
  target: 'chat' | 'studio';
  kind: 'switched' | 'cleared';
  from: MediaModelChoice;
  to?: MediaModelChoice;
}

export class MediaConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function seedConfig(): MediaConfig {
  return { version: 2, marks: [], prefs: { ...DEFAULT_MEDIA_PREFS, userDefaults: {} } };
}

function sanitizePrefs(raw: unknown): MediaPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<MediaPrefs>;
  const choice = (c: unknown): MediaModelChoice | null =>
    c &&
    typeof c === 'object' &&
    typeof (c as MediaModelChoice).modelId === 'string' &&
    typeof (c as MediaModelChoice).providerRef === 'string'
      ? {
          modelId: (c as MediaModelChoice).modelId,
          providerRef: (c as MediaModelChoice).providerRef,
        }
      : null;
  const studio = choice(r.studioLast);
  const params =
    r.studioLast && typeof r.studioLast.params === 'object' ? r.studioLast.params : undefined;
  return {
    chatDefaultImage: choice(r.chatDefaultImage),
    studioLast: studio ? { ...studio, ...(params ? { params } : {}) } : null,
    autoAddGenerated:
      typeof r.autoAddGenerated === 'boolean'
        ? r.autoAddGenerated
        : DEFAULT_MEDIA_PREFS.autoAddGenerated,
    autoAddUploads:
      typeof r.autoAddUploads === 'boolean' ? r.autoAddUploads : DEFAULT_MEDIA_PREFS.autoAddUploads,
    userDefaults: r.userDefaults && typeof r.userDefaults === 'object' ? { ...r.userDefaults } : {},
  };
}

export class MediaConfigStore {
  private cfg: MediaConfig;
  private readonly file: string;

  constructor(
    root: string,
    private readonly source: ProviderSource,
  ) {
    ensurePrivateDir(root);
    this.file = path.join(root, 'config.json');
    this.cfg = this.load();
  }

  private load(): MediaConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<MediaConfig>;
      // 2.1.0 未发布：旧的独立供应商配置（version 1）不迁移，只保留偏好
      return {
        version: 2,
        marks: Array.isArray(raw.marks)
          ? raw.marks.filter(
              (m) =>
                m &&
                typeof m.providerRef === 'string' &&
                typeof m.upstream === 'string' &&
                (m.modelId === null || typeof m.modelId === 'string'),
            )
          : [],
        prefs: sanitizePrefs(raw.prefs),
      };
    } catch {
      return seedConfig();
    }
  }

  private save(): void {
    writePrivateFileAtomic(this.file, JSON.stringify(this.cfg, null, 2));
  }

  // ---------- 读取 ----------

  private shared(): SharedProvider[] {
    try {
      return this.source.list();
    } catch {
      return [];
    }
  }

  providers(): MediaProviderView[] {
    return this.shared().map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.presetId ? { presetId: p.presetId } : {}),
      enabled: p.enabled,
      hasKey: p.hasKey,
    }));
  }

  bindings(): ProviderBinding[] {
    return imageBindings(this.shared(), this.cfg.marks);
  }

  marks(): ImageMark[] {
    return this.cfg.marks.map((m) => ({ ...m }));
  }

  prefs(): MediaPrefs {
    return JSON.parse(JSON.stringify(this.cfg.prefs)) as MediaPrefs;
  }

  availability(): ProviderAvailability[] {
    return this.shared().map((p) => ({ id: p.id, enabled: p.enabled, hasKey: p.hasKey }));
  }

  binding(choice: MediaModelChoice): ProviderBinding | undefined {
    return this.bindings().find(
      (b) => b.modelId === choice.modelId && b.providerRef === choice.providerRef,
    );
  }

  isUsable(choice: MediaModelChoice | null): boolean {
    if (!choice || !getImageSpec(choice.modelId)) return false;
    const b = this.binding(choice);
    return !!b && isBindingUsable(b, this.availability());
  }

  /** 生成用的连接信息（主进程内用；含明文 Key） */
  endpoint(
    choice: MediaModelChoice,
  ): { binding: ProviderBinding; baseURL: string; apiKey: string } | null {
    const b = this.binding(choice);
    const p = this.shared().find((x) => x.id === choice.providerRef);
    if (!b || !p) return null;
    return { binding: b, baseURL: imageBaseURL(p, b.presetKey), apiKey: this.source.apiKey(p.id) };
  }

  // ---------- 图片模型标记（在供应商设置的模型列表里操作） ----------

  /** modelId：标为该图片模型；null：标为「不是图片模型」；undefined：清除标记，回到自动识别 */
  markImage(input: {
    providerRef: string;
    upstream: string;
    modelId?: string | null;
  }): ChoiceChange[] {
    const upstream = String(input.upstream ?? '').trim();
    if (!input.providerRef || !upstream) throw new MediaConfigError('invalid', 'model required');
    if (typeof input.modelId === 'string' && !getImageSpec(input.modelId))
      throw new MediaConfigError('invalid', 'unknown model');
    this.cfg.marks = this.cfg.marks.filter(
      (m) => !(m.providerRef === input.providerRef && m.upstream === upstream),
    );
    if (input.modelId !== undefined)
      this.cfg.marks.push({ providerRef: input.providerRef, upstream, modelId: input.modelId });
    const changes = this.reconcile();
    this.save();
    return changes;
  }

  /** 共用供应商配置变化后调用：校正默认选择 */
  providersChanged(): ChoiceChange[] {
    const changes = this.reconcile();
    if (changes.length) this.save();
    return changes;
  }

  // ---------- 偏好 ----------

  setChatDefault(choice: MediaModelChoice | null): void {
    if (choice && !this.isUsable(choice))
      throw new MediaConfigError('not_usable', 'model/provider is not enabled or has no key');
    this.cfg.prefs.chatDefaultImage = choice
      ? { modelId: choice.modelId, providerRef: choice.providerRef }
      : null;
    this.save();
  }

  setStudioLast(choice: (MediaModelChoice & { params?: MediaParams }) | null): void {
    this.cfg.prefs.studioLast = choice
      ? {
          modelId: choice.modelId,
          providerRef: choice.providerRef,
          ...(choice.params ? { params: choice.params } : {}),
        }
      : null;
    this.save();
  }

  setPrefs(p: Partial<Pick<MediaPrefs, 'autoAddGenerated' | 'autoAddUploads'>>): void {
    if (typeof p.autoAddGenerated === 'boolean')
      this.cfg.prefs.autoAddGenerated = p.autoAddGenerated;
    if (typeof p.autoAddUploads === 'boolean') this.cfg.prefs.autoAddUploads = p.autoAddUploads;
    this.save();
  }

  setUserDefaults(modelId: string, params: MediaParams | null): void {
    const spec = getImageSpec(modelId);
    if (!spec) throw new MediaConfigError('invalid', 'unknown model');
    if (params) this.cfg.prefs.userDefaults[modelId] = migrateParams(spec, params).params;
    else delete this.cfg.prefs.userDefaults[modelId];
    this.save();
  }

  /**
   * 供应商 / 绑定变化后校正默认选择：
   * 当前供应商不可用 → 同模型下另一家可用供应商（switched）；没有 → 清空（cleared）。从不跨模型兜底。
   */
  reconcile(): ChoiceChange[] {
    const changes: ChoiceChange[] = [];
    const avail = this.availability();
    const bindings = this.bindings();
    const chat = reconcileChoice(this.cfg.prefs.chatDefaultImage, bindings, avail);
    if (chat.kind === 'switched') {
      this.cfg.prefs.chatDefaultImage = chat.choice;
      changes.push({ target: 'chat', kind: 'switched', from: chat.from, to: chat.choice });
    } else if (chat.kind === 'cleared') {
      this.cfg.prefs.chatDefaultImage = null;
      changes.push({ target: 'chat', kind: 'cleared', from: chat.from });
    }
    const last = this.cfg.prefs.studioLast;
    const studio = reconcileChoice(
      last ? { modelId: last.modelId, providerRef: last.providerRef } : null,
      bindings,
      avail,
    );
    if (studio.kind === 'switched' && last) {
      this.cfg.prefs.studioLast = { ...last, providerRef: studio.choice.providerRef };
      changes.push({ target: 'studio', kind: 'switched', from: studio.from, to: studio.choice });
    } else if (studio.kind === 'cleared' && last) {
      // 工作台保留参数，只清供应商：下次进入时让用户重新选
      this.cfg.prefs.studioLast = null;
      changes.push({ target: 'studio', kind: 'cleared', from: studio.from });
    }
    return changes;
  }
}
