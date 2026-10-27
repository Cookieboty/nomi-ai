/**
 * 图片工作台的纯逻辑（无 React）：进度估算、风格模板、草稿、schema → 控件形态。
 * 进度只是按状态与已用时间估算，上游接口不返回真实进度，界面上要标注「估算」。
 */
import type { MediaParams, ParamValue, ResolvedField } from '@nomi-ai/gateway/media';

export const STYLE_KEYS = ['general', 'anime', 'realistic', 'illustration', 'cyberpunk'] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];

/** 推荐词：按钮文案 + 点击后填入的完整提示词 */
export const SUGGESTIONS = [
  { label: 'ui.media.suggest-lake', prompt: 'ui.media.suggest-lake-prompt' },
  { label: 'ui.media.suggest-cyber', prompt: 'ui.media.suggest-cyber-prompt' },
  { label: 'ui.media.suggest-anime', prompt: 'ui.media.suggest-anime-prompt' },
  { label: 'ui.media.suggest-poster', prompt: 'ui.media.suggest-poster-prompt' },
  { label: 'ui.media.suggest-scenery', prompt: 'ui.media.suggest-scenery-prompt' },
] as const;

/** 风格：名称 + 提示词模板（schema 无风格参数时追加到提示词；通用不追加） */
export const STYLE_I18N: Record<StyleKey, { label: string; prompt: string | null }> = {
  general: { label: 'ui.chat-settings.general', prompt: null },
  anime: { label: 'ui.media.style-anime', prompt: 'ui.media.style-anime-prompt' },
  realistic: { label: 'ui.media.style-realistic', prompt: 'ui.media.style-realistic-prompt' },
  illustration: {
    label: 'ui.media.style-illustration',
    prompt: 'ui.media.style-illustration-prompt',
  },
  cyberpunk: { label: 'ui.media.style-cyberpunk', prompt: 'ui.media.style-cyberpunk-prompt' },
};

export const STAGE_I18N = [
  'ui.media.stage-parse',
  'ui.media.stage-compose',
  'ui.media.stage-refine',
] as const;

export const CAP_I18N: Partial<Record<string, string>> = {
  t2i: 'ui.media.cap-t2i',
  i2i: 'ui.media.cap-i2i',
  edit: 'ui.media.cap-edit',
};

/** 估算的典型耗时（毫秒）；模型可在 x-task.timeoutMs 外另给，这里取保守常数 */
export const EXPECTED_MS = 20_000;

export interface ProgressEstimate {
  /** 0–100；运行中最多 95，完成才到 100 */
  percent: number;
  /** 当前阶段：0 解析提示词，1 构图与风格生成，2 细节优化 */
  stage: 0 | 1 | 2;
  elapsedSec: number;
}

export function estimateProgress(
  task: { status: string; createdAt: number; finishedAt?: number },
  now: number,
  expectedMs = EXPECTED_MS,
): ProgressEstimate {
  const elapsed = Math.max(0, (task.finishedAt ?? now) - task.createdAt);
  const elapsedSec = Math.round(elapsed / 1000);
  if (task.status === 'succeeded') return { percent: 100, stage: 2, elapsedSec };
  if (task.status === 'queued') return { percent: 2, stage: 0, elapsedSec };
  // 指数逼近：用时 = 预期耗时时约 80%，之后越来越慢，封顶 95
  const percent = Math.min(95, Math.round(5 + 90 * (1 - Math.exp(-1.7 * (elapsed / expectedMs)))));
  const stage = percent < 15 ? 0 : percent < 80 ? 1 : 2;
  return { percent, stage, elapsedSec };
}

/** schema 里没有风格参数时，把风格作为提示词后缀；通用 / 空后缀不改提示词 */
export function applyStyle(prompt: string, suffix: string | undefined): string {
  const p = prompt.trim();
  if (!suffix || !p) return p;
  return p.endsWith(suffix) ? p : `${p}${suffix}`;
}

export function hasStyleParam(properties: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(properties, 'style');
}

/** 可以用分段控件展示的取值；不适合（无枚举、范围过大）返回 null */
export function segmentOptions(f: ResolvedField, maxSegments = 6): ParamValue[] | null {
  const ui = f['x-ui'];
  if (f.enum && ui.control === 'chips') return f.enum;
  if (
    f.type === 'integer' &&
    typeof f.minimum === 'number' &&
    typeof f.maximum === 'number' &&
    f.maximum - f.minimum + 1 <= maxSegments &&
    f.maximum >= f.minimum
  ) {
    const out: number[] = [];
    for (let v = f.minimum; v <= f.maximum; v++) out.push(v);
    return out;
  }
  return null;
}

// ───────── 草稿（只存本机 localStorage） ─────────

export const DRAFT_KEY = 'nomi.studio.draft.v1';

export interface StudioDraft {
  modelId: string;
  providerRef: string;
  prompt: string;
  params: MediaParams;
  style: StyleKey;
  savedAt: number;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export function saveDraft(store: KV, d: Omit<StudioDraft, 'savedAt'>, now = Date.now()): void {
  store.setItem(DRAFT_KEY, JSON.stringify({ ...d, savedAt: now }));
}

export function loadDraft(store: KV): StudioDraft | null {
  try {
    const raw = store.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<StudioDraft>;
    if (typeof d.modelId !== 'string' || typeof d.prompt !== 'string') return null;
    return {
      modelId: d.modelId,
      providerRef: typeof d.providerRef === 'string' ? d.providerRef : '',
      prompt: d.prompt,
      params: d.params && typeof d.params === 'object' ? d.params : {},
      style: STYLE_KEYS.includes(d.style as StyleKey) ? (d.style as StyleKey) : 'general',
      savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/png', 'image/jpeg'];

export function uploadAllowed(file: { type: string; size: number }): boolean {
  return UPLOAD_TYPES.includes(file.type) && file.size <= MAX_UPLOAD_BYTES;
}
