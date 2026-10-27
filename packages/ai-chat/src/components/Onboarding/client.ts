/** 新手引导与主进程的通信（`ai:onboarding:*`）；没有 IPC（浏览器预览 / 测试）时退化为本地状态 */
import { EMPTY_USER_PROFILE, normalizeUserProfile, type UserProfile } from '@nomi-ai/types';

/** 同一窗口内广播职业与兴趣的变化 */
const PROFILE_EVENT = 'cd:onboarding-profile';
/** 引导请对话窗口打开「设置 → 模型与供应商」 */
export const OPEN_MODELS_EVENT = 'cd:onboarding-open-models';

export interface OnboardingState {
  done: boolean;
  skipped?: boolean;
}
export type MascotCmd =
  { type: 'say'; text: string; motion?: string } | { type: 'motion'; name: string };

interface Bridge {
  invoke(ch: string, ...a: unknown[]): Promise<unknown>;
  on?(ch: string, fn: (p: unknown) => void): () => void;
}
const bridge = (): Bridge | undefined => (window as unknown as { aiIPC?: Bridge }).aiIPC;

export const onboardingClient = {
  available: () => Boolean(bridge()),
  async get(): Promise<OnboardingState> {
    const b = bridge();
    if (!b) return { done: true };
    return (
      ((await b.invoke('ai:onboarding:get').catch(() => null)) as OnboardingState) ?? { done: true }
    );
  },
  async complete(skipped: boolean): Promise<void> {
    await bridge()
      ?.invoke('ai:onboarding:complete', { skipped })
      .catch(() => undefined);
  },
  async reopen(): Promise<void> {
    const b = bridge();
    if (b) await b.invoke('ai:onboarding:reopen').catch(() => undefined);
    // 同一窗口内立即显示（主进程也会广播 ai:onboarding:show）
    window.dispatchEvent(new CustomEvent('cd:onboarding-show'));
  },
  mascot(cmd: MascotCmd): void {
    void bridge()
      ?.invoke('ai:onboarding:mascot', cmd)
      .catch(() => undefined);
  },
  onShow(fn: () => void): () => void {
    const off = bridge()?.on?.('ai:onboarding:show', () => fn());
    window.addEventListener('cd:onboarding-show', fn);
    return () => {
      off?.();
      window.removeEventListener('cd:onboarding-show', fn);
    };
  },
  /** 职业与兴趣（没选过为空） */
  async profile(): Promise<UserProfile> {
    const b = bridge();
    if (!b) return EMPTY_USER_PROFILE;
    return normalizeUserProfile(await b.invoke('ai:onboarding:profile').catch(() => null));
  },
  async setProfile(p: UserProfile): Promise<UserProfile> {
    const saved = normalizeUserProfile(
      (await bridge()
        ?.invoke('ai:onboarding:set-profile', p)
        .catch(() => null)) ?? p,
    );
    // 同一窗口立即生效（主进程也会广播 ai:onboarding:profile-changed）
    window.dispatchEvent(new CustomEvent<UserProfile>(PROFILE_EVENT, { detail: saved }));
    return saved;
  },
  onProfile(fn: (p: UserProfile) => void): () => void {
    const off = bridge()?.on?.('ai:onboarding:profile-changed', (p) => fn(normalizeUserProfile(p)));
    const local = (e: Event) => fn(normalizeUserProfile((e as CustomEvent<unknown>).detail));
    window.addEventListener(PROFILE_EVENT, local);
    return () => {
      off?.();
      window.removeEventListener(PROFILE_EVENT, local);
    };
  },
  async persona(): Promise<string> {
    const r = await bridge()
      ?.invoke('ai:mem:persona')
      .catch(() => '');
    if (typeof r === 'string') return r;
    const o = r as { text?: string; content?: string } | null;
    return o?.text ?? o?.content ?? '';
  },
  async setPersona(text: string): Promise<void> {
    await bridge()
      ?.invoke('ai:mem:set-persona', text)
      .catch(() => undefined);
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
