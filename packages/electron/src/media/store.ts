/**
 * 生图配置存储（主进程）：供应商（Key 经 safeStorage 加密）、模型×供应商绑定、偏好。
 * 文件：userData/media/config.json（0600 原子写）。Key 永远不出主进程，对外只给 hasKey / keyHint。
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_MEDIA_PREFS,
  MEDIA_PROTOCOLS,
  MEDIA_PROVIDER_PRESETS,
  getImageSpec,
  isBindingUsable,
  migrateParams,
  reconcileChoice,
  type MediaModelChoice,
  type MediaParams,
  type MediaPrefs,
  type MediaProtocol,
  type ProviderAvailability,
  type ProviderBinding,
} from '@nomi-ai/gateway/media';

import { ensurePrivateDir, writePrivateFileAtomic } from '../utils/privateFile';

export interface MediaProviderRecord {
  id: string;
  name: string;
  baseURL: string;
  /** 预设 id；自定义供应商为空 */
  preset?: string;
  enabled: boolean;
  /** safeStorage 加密后的 Key（enc:...） */
  apiKeyEnc?: string;
  /** Key 末 4 位，仅用于界面提示 */
  keyHint?: string;
}

export interface MediaProviderView extends Omit<MediaProviderRecord, 'apiKeyEnc'> {
  hasKey: boolean;
  custom: boolean;
}

export interface MediaConfig {
  version: 1;
  providers: MediaProviderRecord[];
  bindings: ProviderBinding[];
  prefs: MediaPrefs;
}

export interface SecretCodec {
  encrypt(value: string): string;
  decrypt(value: string | undefined): string;
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

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function seedConfig(): MediaConfig {
  return {
    version: 1,
    providers: [],
    bindings: [],
    prefs: { ...DEFAULT_MEDIA_PREFS, userDefaults: {} },
  };
}

/** 补齐预设供应商与预设绑定（新版本新增预设时，老用户也能看到） */
export function ensurePresets(cfg: MediaConfig): MediaConfig {
  for (const p of MEDIA_PROVIDER_PRESETS) {
    if (!cfg.providers.some((x) => x.id === p.id))
      cfg.providers.push({
        id: p.id,
        name: p.name,
        baseURL: p.baseURL,
        preset: p.id,
        enabled: true,
      });
    for (const b of p.bindings)
      if (!cfg.bindings.some((x) => x.providerRef === p.id && x.modelId === b.modelId))
        cfg.bindings.push({ ...b, providerRef: p.id, enabled: true });
  }
  return cfg;
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
    private readonly codec: SecretCodec,
  ) {
    ensurePrivateDir(root);
    this.file = path.join(root, 'config.json');
    this.cfg = ensurePresets(this.load());
    // 绑定里引用的模型若已下线：保留记录但不可用（getImageSpec 为空，usable 判定会过滤）
  }

  private load(): MediaConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<MediaConfig>;
      return {
        version: 1,
        providers: Array.isArray(raw.providers)
          ? raw.providers.filter((p) => p && ID_RE.test(p.id))
          : [],
        bindings: Array.isArray(raw.bindings)
          ? raw.bindings.filter(
              (b) => b && typeof b.modelId === 'string' && MEDIA_PROTOCOLS.includes(b.presetKey),
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

  providers(): MediaProviderView[] {
    return this.cfg.providers.map(({ apiKeyEnc, ...p }) => ({
      ...p,
      hasKey: !!apiKeyEnc,
      custom: !p.preset,
    }));
  }

  bindings(): ProviderBinding[] {
    return this.cfg.bindings.map((b) => ({ ...b }));
  }

  prefs(): MediaPrefs {
    return JSON.parse(JSON.stringify(this.cfg.prefs)) as MediaPrefs;
  }

  availability(): ProviderAvailability[] {
    return this.cfg.providers.map((p) => ({ id: p.id, enabled: p.enabled, hasKey: !!p.apiKeyEnc }));
  }

  provider(id: string): MediaProviderRecord | undefined {
    return this.cfg.providers.find((p) => p.id === id);
  }

  apiKey(id: string): string {
    return this.codec.decrypt(this.provider(id)?.apiKeyEnc);
  }

  binding(choice: MediaModelChoice): ProviderBinding | undefined {
    return this.cfg.bindings.find(
      (b) => b.modelId === choice.modelId && b.providerRef === choice.providerRef,
    );
  }

  isUsable(choice: MediaModelChoice | null): boolean {
    if (!choice || !getImageSpec(choice.modelId)) return false;
    const b = this.binding(choice);
    return !!b && isBindingUsable(b, this.availability());
  }

  // ---------- 供应商 ----------

  upsertProvider(input: {
    id?: string;
    name?: string;
    baseURL?: string;
    enabled?: boolean;
    apiKey?: string | null;
  }): { provider: MediaProviderView; changes: ChoiceChange[] } {
    let rec = input.id ? this.provider(input.id) : undefined;
    if (!rec) {
      const name = String(input.name ?? '').trim();
      const baseURL = String(input.baseURL ?? '').trim();
      if (!name) throw new MediaConfigError('invalid', 'name required');
      if (!/^https?:\/\//i.test(baseURL))
        throw new MediaConfigError('invalid', 'baseURL must be http(s)');
      let id = input.id && ID_RE.test(input.id) ? input.id : `custom-${Date.now().toString(36)}`;
      while (this.provider(id)) id = `${id}-x`;
      rec = { id, name, baseURL, enabled: true };
      this.cfg.providers.push(rec);
    } else {
      if (input.name !== undefined && !rec.preset) rec.name = String(input.name).trim() || rec.name;
      if (input.baseURL !== undefined) {
        const u = String(input.baseURL).trim();
        if (!/^https?:\/\//i.test(u))
          throw new MediaConfigError('invalid', 'baseURL must be http(s)');
        rec.baseURL = u;
      }
    }
    if (typeof input.enabled === 'boolean') rec.enabled = input.enabled;
    if (input.apiKey === null || input.apiKey === '') {
      delete rec.apiKeyEnc;
      delete rec.keyHint;
    } else if (typeof input.apiKey === 'string') {
      const k = input.apiKey.trim();
      rec.apiKeyEnc = this.codec.encrypt(k);
      rec.keyHint = k.slice(-4);
    }
    const changes = this.reconcile();
    this.save();
    return { provider: this.providers().find((p) => p.id === rec!.id)!, changes };
  }

  removeProvider(id: string): ChoiceChange[] {
    const rec = this.provider(id);
    if (!rec) return [];
    if (rec.preset) throw new MediaConfigError('invalid', 'preset providers cannot be removed');
    this.cfg.providers = this.cfg.providers.filter((p) => p.id !== id);
    this.cfg.bindings = this.cfg.bindings.filter((b) => b.providerRef !== id);
    const changes = this.reconcile();
    this.save();
    return changes;
  }

  // ---------- 绑定 ----------

  upsertBinding(input: {
    providerRef: string;
    modelId: string;
    enabled?: boolean;
    presetKey?: MediaProtocol;
    upstreamModelName?: string;
  }): ChoiceChange[] {
    if (!this.provider(input.providerRef))
      throw new MediaConfigError('not_found', 'provider not found');
    if (!getImageSpec(input.modelId)) throw new MediaConfigError('invalid', 'unknown model');
    let b = this.binding(input);
    if (!b) {
      if (!input.presetKey || !MEDIA_PROTOCOLS.includes(input.presetKey))
        throw new MediaConfigError('invalid', 'protocol required');
      const upstream = String(input.upstreamModelName ?? '').trim();
      if (!upstream) throw new MediaConfigError('invalid', 'upstream model name required');
      b = {
        providerRef: input.providerRef,
        modelId: input.modelId,
        enabled: true,
        presetKey: input.presetKey,
        upstreamModelName: upstream,
      };
      this.cfg.bindings.push(b);
    }
    if (typeof input.enabled === 'boolean') b.enabled = input.enabled;
    if (input.presetKey && MEDIA_PROTOCOLS.includes(input.presetKey)) b.presetKey = input.presetKey;
    if (typeof input.upstreamModelName === 'string' && input.upstreamModelName.trim())
      b.upstreamModelName = input.upstreamModelName.trim();
    const changes = this.reconcile();
    this.save();
    return changes;
  }

  removeBinding(choice: MediaModelChoice): ChoiceChange[] {
    this.cfg.bindings = this.cfg.bindings.filter(
      (b) => !(b.modelId === choice.modelId && b.providerRef === choice.providerRef),
    );
    const changes = this.reconcile();
    this.save();
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
    const chat = reconcileChoice(this.cfg.prefs.chatDefaultImage, this.cfg.bindings, avail);
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
      this.cfg.bindings,
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
