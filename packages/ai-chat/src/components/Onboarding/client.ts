/** 新手引导与主进程的通信（应用契约 `onboarding.*`）；没有契约传输（浏览器预览 / 测试）时退化为本地状态 */
import type { SemanticGesture } from '@nomi-ai/character-contract';
import { EMPTY_USER_PROFILE, normalizeUserProfile, type UserProfile } from '@nomi-ai/types';

import { api, hasTransport } from '../../services/api';
import { memClient } from '../../services/memClient';

/** 同一窗口内广播职业与兴趣的变化 */
const PROFILE_EVENT = 'cd:onboarding-profile';
/** 引导请对话窗口打开「设置 → 模型与供应商」 */
export const OPEN_MODELS_EVENT = 'cd:onboarding-open-models';

export interface OnboardingState {
  done: boolean;
  skipped?: boolean;
}
/** 对话窗口 → 桌面角色（只有语义名，§10.5）：说一句（可带语义手势）、语义手势、正在等回复 */
export type MascotCmd =
  | { type: 'say'; text: string; gesture?: SemanticGesture }
  | { type: 'gesture'; name: SemanticGesture }
  | { type: 'reply'; phase: 'waiting' | 'settled' };

export const onboardingClient = {
  available: () => hasTransport(),
  async get(): Promise<OnboardingState> {
    if (!hasTransport()) return { done: true };
    return (
      ((await api.onboarding.get().catch(() => null)) as OnboardingState | null) ?? {
        done: true,
      }
    );
  },
  async complete(skipped: boolean): Promise<void> {
    if (!hasTransport()) return;
    await api.onboarding.complete({ skipped }).catch(() => undefined);
  },
  async reopen(): Promise<void> {
    if (hasTransport()) await api.onboarding.reopen().catch(() => undefined);
    // 同一窗口内立即显示（主进程也会广播 onboarding.show）
    window.dispatchEvent(new CustomEvent('cd:onboarding-show'));
  },
  mascot(cmd: MascotCmd): void {
    if (!hasTransport()) return;
    void api.onboarding.mascot(cmd).catch(() => undefined);
  },
  onShow(fn: () => void): () => void {
    const off = hasTransport() ? api.on('onboarding.show', () => fn()) : undefined;
    window.addEventListener('cd:onboarding-show', fn);
    return () => {
      off?.();
      window.removeEventListener('cd:onboarding-show', fn);
    };
  },
  /** 职业与兴趣（没选过为空） */
  async profile(): Promise<UserProfile> {
    if (!hasTransport()) return EMPTY_USER_PROFILE;
    return normalizeUserProfile(await api.onboarding.profile().catch(() => null));
  },
  async setProfile(p: UserProfile): Promise<UserProfile> {
    const saved = normalizeUserProfile(
      (hasTransport() ? await api.onboarding.setProfile(p).catch(() => null) : null) ?? p,
    );
    // 同一窗口立即生效（主进程也会广播 onboarding.profileChanged）
    window.dispatchEvent(new CustomEvent<UserProfile>(PROFILE_EVENT, { detail: saved }));
    return saved;
  },
  onProfile(fn: (p: UserProfile) => void): () => void {
    const off = hasTransport()
      ? api.on('onboarding.profileChanged', (p) => fn(normalizeUserProfile(p)))
      : undefined;
    const local = (e: Event) => fn(normalizeUserProfile((e as CustomEvent<unknown>).detail));
    window.addEventListener(PROFILE_EVENT, local);
    return () => {
      off?.();
      window.removeEventListener(PROFILE_EVENT, local);
    };
  },
  // 「关于我」（persona.md）属于记忆域：经它的客户端模块读写，失败按空 / 忽略处理
  async persona(): Promise<string> {
    if (!memClient.available()) return '';
    const r: unknown = await memClient.persona().catch(() => '');
    if (typeof r === 'string') return r;
    const o = r as { text?: string; content?: string } | null;
    return o?.text ?? o?.content ?? '';
  },
  async setPersona(text: string): Promise<void> {
    if (!memClient.available()) return;
    await memClient.setPersona(text).catch(() => undefined);
  },
};

const BEGIN = '<!-- onboarding -->';
const END = '<!-- /onboarding -->';
/** 把引导里填写的称呼 / 语气写进「关于我」（persona.md）里固定的一段，重复引导时替换而不是追加 */
export function mergePersona(existing: string, lines: string[]): string {
  const block = lines.length ? `${BEGIN}\n${lines.join('\n')}\n${END}` : '';
  const i = existing.indexOf(BEGIN);
  const j = existing.indexOf(END);
  if (i >= 0 && j > i) {
    const rest = (existing.slice(0, i) + existing.slice(j + END.length)).trim();
    return [block, rest].filter(Boolean).join('\n\n');
  }
  return [block, existing.trim()].filter(Boolean).join('\n\n');
}

/** 「关于我」里引导那一段的各行（没有这一段时为空） */
export function personaBlockLines(existing: string): string[] {
  const i = existing.indexOf(BEGIN);
  const j = existing.indexOf(END);
  if (i < 0 || j <= i) return [];
  return existing
    .slice(i + BEGIN.length, j)
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 按文案模板（`{0}`、`{1}` 占位）解析一行，返回各占位符的值；对不上返回 null */
export function matchTemplate(template: string, line: string): string[] | null {
  const parts = template.split(/\{\d+\}/);
  if (parts.length < 2) return null;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${parts.map(esc).join('(.+?)')}$`);
  const m = re.exec(line);
  return m ? m.slice(1) : null;
}
