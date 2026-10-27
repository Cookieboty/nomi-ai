/** 知识库设置（纯逻辑 + 校验） */
export interface KbSource {
  id: string;
  kind: 'folder';
  /** kind=folder 时为文件夹绝对路径 */
  path?: string;
  addedAt: number;
  enabled: boolean;
}

export interface KbModelRef {
  enabled: boolean;
  providerId: string;
  model: string;
}

export interface KbSettings {
  sources: KbSource[];
  embed: KbModelRef;
  rerank: KbModelRef;
  ocr: { enabled: boolean; langs: string[] };
  /** 用户已同意把文件片段发给这些云端 provider 做向量 / 重排 */
  cloudConsent: string[];
  /** 每次回答引用的片段数 */
  topK: number;
}

export const DEFAULT_KB_SETTINGS: KbSettings = {
  sources: [],
  embed: { enabled: false, providerId: '', model: '' },
  rerank: { enabled: false, providerId: '', model: '' },
  ocr: { enabled: false, langs: ['chi_sim', 'eng'] },
  cloudConsent: [],
  topK: 6,
};

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

function modelRef(v: unknown): KbModelRef {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { enabled: o.enabled === true, providerId: str(o.providerId), model: str(o.model) };
}

export function sanitizeKbSettings(raw: unknown): KbSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sources = Array.isArray(o.sources)
    ? (o.sources as Array<Record<string, unknown>>)
        .filter(
          (s) =>
            s &&
            typeof s.id === 'string' &&
            s.kind === 'folder' &&
            typeof s.path === 'string' &&
            !!s.path,
        )
        .map((s) => ({
          id: String(s.id),
          kind: s.kind as KbSource['kind'],
          path: String(s.path),
          addedAt: typeof s.addedAt === 'number' ? s.addedAt : 0,
          enabled: s.enabled !== false,
        }))
    : [];
  const ocr = (o.ocr && typeof o.ocr === 'object' ? o.ocr : {}) as Record<string, unknown>;
  const langs = Array.isArray(ocr.langs)
    ? (ocr.langs as unknown[]).filter((l): l is string => l === 'eng' || l === 'chi_sim')
    : DEFAULT_KB_SETTINGS.ocr.langs;
  const topK = typeof o.topK === 'number' ? Math.round(o.topK) : DEFAULT_KB_SETTINGS.topK;
  return {
    sources,
    embed: modelRef(o.embed),
    rerank: modelRef(o.rerank),
    ocr: { enabled: ocr.enabled === true, langs: langs.length ? langs : ['eng'] },
    cloudConsent: Array.isArray(o.cloudConsent)
      ? (o.cloudConsent as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    topK: Math.min(12, Math.max(2, topK)),
  };
}
