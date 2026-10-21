/** 新手引导与主进程的通信（`ai:onboarding:*`）；没有 IPC（浏览器预览 / 测试）时退化为本地状态 */
export interface OnboardingState {
  done: boolean;
  skipped?: boolean;
}
export type MascotCmd =
  | { type: 'say'; text: string; motion?: string }
  | { type: 'voice-style'; style: VoiceStyle; preview?: string }
  | { type: 'motion'; name: string };
export type VoiceStyle = 'soft' | 'lively' | 'calm' | 'off';

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
