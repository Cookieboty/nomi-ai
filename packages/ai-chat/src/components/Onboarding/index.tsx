/**
 * 首次启动引导：语言 → 主题 → 角色与声音 → 称呼与语气 → 供应商 → 隐私。
 * 每一步都能「跳过这一步」，右上角「跳过引导」直接结束；完成后可在「设置 → 通用」重新打开。
 * 看板娘在引导中打招呼、回应每一步的选择。
 */
import {
  ModalHostContext,
  THEMES,
  currentTheme,
  getLocalePref,
  setLocalePref,
  setTheme,
  t,
  useFocusTrap,
  useLocale,
  type LocalePref,
  type ThemePref,
  Icon,
} from '@nomi-ai/ui';
import { Cloud, FolderLock, KeyRound, Lock } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { ProviderPanel } from '../ProviderPanel';

import { mergePersona, onboardingClient, type Character, type VoiceStyle } from './client';
import styles from './index.module.css';

/** 供应商面板以内嵌方式渲染在引导卡片里（不弹出自己的对话框） */
const INLINE = { mode: 'inline' } as const;

/** 引导里嵌入的面板出错时不影响整个引导（仍可跳过这一步） */
class StepBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className={styles.note}>{t('暂时无法加载供应商设置，可以先跳过，之后在设置里添加。')}</p>
    ) : (
      this.props.children
    );
  }
}

const STEPS = ['language', 'theme', 'character', 'persona', 'provider', 'privacy'] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLE: Record<Step, () => string> = {
  language: () => t('选择界面语言'),
  theme: () => t('选一个喜欢的外观'),
  character: () => t('选一位陪伴你的伙伴'),
  persona: () => t('她该怎么称呼你？'),
  provider: () => t('接入一个 AI 模型'),
  privacy: () => t('你的数据只留在这台电脑上'),
};
/** 看板娘在每一步说的话 */
const STEP_LINE: Record<Step, () => string> = {
  language: () => t('你好，我是 Nomi·诺米，住在你桌面上的 AI 伙伴。花一分钟认识一下吧！'),
  theme: () => t('先挑一个看着舒服的外观吧，我们每天都要见面呢。'),
  character: () => t('想让我以什么样子陪着你？点一下就能换，之后也能随时改。'),
  persona: () => t('告诉我怎么称呼你，我会好好记住。'),
  provider: () => t('接上一个 AI 模型，我就能帮你规划任务、把想法变成行动。'),
  privacy: () => t('放心，我们的对话和记忆都只留在这台电脑上。'),
};

const LANGS: { id: LocalePref; label: () => string; hint: () => string }[] = [
  { id: 'system', label: () => t('跟随系统'), hint: () => t('自动匹配电脑的语言') },
  // i18n-ignore
  { id: 'zh-CN', label: () => '中文', hint: () => '简体中文' },
  { id: 'en', label: () => 'English', hint: () => 'English' },
];

const VOICES: { id: VoiceStyle; label: () => string; hint: () => string }[] = [
  { id: 'soft', label: () => t('柔和'), hint: () => t('轻声细语') },
  { id: 'lively', label: () => t('活泼'), hint: () => t('元气满满') },
  { id: 'calm', label: () => t('沉稳'), hint: () => t('平静从容') },
  { id: 'off', label: () => t('不出声'), hint: () => t('只用气泡') },
];

const TONES: { id: string; label: () => string; desc: () => string }[] = [
  { id: 'gentle', label: () => t('温柔体贴'), desc: () => t('语气温柔，多关心对方') },
  { id: 'lively', label: () => t('元气活泼'), desc: () => t('热情有活力，偶尔用表情') },
  { id: 'concise', label: () => t('简洁专业'), desc: () => t('直接给结论，少寒暄') },
  { id: 'playful', label: () => t('俏皮幽默'), desc: () => t('轻松幽默，适度开玩笑') },
];

export const Onboarding: React.FC<{ onDone: (skipped: boolean) => void }> = ({ onDone }) => {
  useLocale();
  const [i, setI] = useState(0);
  // 引导是阻断式对话框：焦点留在卡片内（Esc 不关闭，需点「跳过引导」）
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef, true);
  const step = STEPS[i]!;
  const [lang, setLang] = useState<LocalePref>(getLocalePref);
  const [theme, setThemeSel] = useState<ThemePref>(() => currentTheme().pref);
  const [chars, setChars] = useState<Character[]>([]);
  const [char, setChar] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceStyle | null>(null);
  const [name, setName] = useState('');
  const [tone, setTone] = useState<string | null>(null);

  useEffect(() => {
    void onboardingClient.characters().then(setChars);
  }, []);
  // 每进入一步，看板娘说一句
  useEffect(() => {
    onboardingClient.mascot({
      type: 'say',
      text: STEP_LINE[step](),
      motion: step === 'language' ? 'wave' : undefined,
    });
  }, [step]);

  const savePersona = useCallback(async () => {
    const lines: string[] = [];
    if (name.trim()) lines.push(t('- 请称呼我：{0}', name.trim().slice(0, 40)));
    const tn = TONES.find((x) => x.id === tone);
    if (tn) lines.push(t('- 回答语气：{0}（{1}）', tn.label(), tn.desc()));
    if (!lines.length) return;
    const cur = await onboardingClient.persona();
    await onboardingClient.setPersona(mergePersona(cur, lines));
    onboardingClient.mascot({
      type: 'say',
      text: name.trim()
        ? t('好的，{0}！以后就这么叫你啦～', name.trim().slice(0, 40))
        : t('记住啦～'),
    });
  }, [name, tone]);

  const finish = useCallback(
    async (skipped: boolean) => {
      await onboardingClient.complete(skipped);
      onboardingClient.mascot({
        type: 'say',
        text: skipped
          ? t('随时可以在设置里重新打开引导哦～')
          : t('准备好啦！我在这里，陪你把每一个任务都变成小小的成就。'),
        motion: skipped ? undefined : 'cheer',
      });
      onDone(skipped);
    },
    [onDone],
  );

  const next = async () => {
    if (step === 'persona') await savePersona();
    if (i === STEPS.length - 1) return finish(false);
    setI(i + 1);
  };
  const skipStep = () => (i === STEPS.length - 1 ? void finish(false) : setI(i + 1));

  const body = (() => {
    switch (step) {
      case 'language':
        return (
          <div className={styles.options} role="radiogroup" aria-label={t('语言')}>
            {LANGS.map((l) => (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={lang === l.id}
                data-testid={`onb-lang-${l.id}`}
                className={`${styles.option} ${lang === l.id ? styles.optionOn : ''}`}
                onClick={() => {
                  setLang(l.id);
                  void setLocalePref(l.id);
                }}
              >
                <span className={styles.optionTitle}>{l.label()}</span>
                <span className={styles.optionHint}>{l.hint()}</span>
              </button>
            ))}
          </div>
        );
      case 'theme': {
        const main = THEMES.filter((x) => x.id === 'ink' || x.id === 'system');
        const more = THEMES.filter((x) => x.id !== 'ink' && x.id !== 'system');
        const card = (x: (typeof THEMES)[number], big: boolean) => (
          <button
            key={x.id}
            type="button"
            role="radio"
            aria-checked={theme === x.id}
            data-testid={`onb-theme-${x.id}`}
            className={`${styles.option} ${big ? '' : styles.optionSmall} ${theme === x.id ? styles.optionOn : ''}`}
            onClick={() => {
              setThemeSel(x.id);
              void setTheme(x.id);
            }}
          >
            <span
              className={styles.swatch}
              aria-hidden
              style={{
                background:
                  x.id === 'system'
                    ? `linear-gradient(110deg, ${x.swatch[0]} 50%, ${x.swatch[2]} 50%)`
                    : `linear-gradient(135deg, ${x.swatch[0]} 60%, ${x.swatch[3]} 60%)`,
              }}
            />
            <span className={styles.optionTitle}>{t(x.name)}</span>
            {big && <span className={styles.optionHint}>{t(x.desc)}</span>}
          </button>
        );
        return (
          <>
            <div className={styles.options} role="radiogroup" aria-label={t('主题')}>
              {main.map((x) => card(x, true))}
            </div>
            <div className={styles.subLabel}>{t('更多配色')}</div>
            <div className={styles.options}>{more.map((x) => card(x, false))}</div>
          </>
        );
      }
      case 'character':
        return (
          <>
            {chars.length ? (
              <div className={styles.chars} role="radiogroup" aria-label={t('角色')}>
                {chars.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={char === c.id}
                    data-testid={`onb-char-${c.id}`}
                    className={`${styles.char} ${char === c.id ? styles.optionOn : ''}`}
                    onClick={() => {
                      setChar(c.id);
                      onboardingClient.mascot({ type: 'select-model', id: c.id });
                    }}
                  >
                    <span className={styles.charAvatar} aria-hidden>
                      {c.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className={styles.charName}>{c.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.note}>
                {t('角色列表加载中…也可以之后在 Nomi 右键菜单里切换。')}
              </p>
            )}
            <div className={styles.subLabel}>{t('她的声音')}</div>
            <div className={styles.options} role="radiogroup" aria-label={t('声音')}>
              {VOICES.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={voice === v.id}
                  data-testid={`onb-voice-${v.id}`}
                  className={`${styles.option} ${styles.optionSmall} ${voice === v.id ? styles.optionOn : ''}`}
                  onClick={() => {
                    setVoice(v.id);
                    onboardingClient.mascot({
                      type: 'voice-style',
                      style: v.id,
                      preview: v.id === 'off' ? undefined : t('你好，我是 Nomi，今天也要加油哦！'),
                    });
                  }}
                >
                  <span className={styles.optionTitle}>{v.label()}</span>
                  <span className={styles.optionHint}>{v.hint()}</span>
                </button>
              ))}
            </div>
            <p className={styles.note}>
              {t('点一下就能试听；之后可在「设置 → 语音与屏幕」细调。')}
            </p>
          </>
        );
      case 'persona':
        return (
          <>
            <label className={styles.field}>
              <span className={styles.subLabel}>{t('称呼')}</span>
              <input
                className={styles.input}
                data-testid="onb-name"
                value={name}
                maxLength={40}
                placeholder={t('例如：小林、主人、你的名字')}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void next()}
              />
            </label>
            <div className={styles.subLabel}>{t('说话的语气')}</div>
            <div className={styles.options} role="radiogroup" aria-label={t('说话的语气')}>
              {TONES.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={tone === x.id}
                  data-testid={`onb-tone-${x.id}`}
                  className={`${styles.option} ${tone === x.id ? styles.optionOn : ''}`}
                  onClick={() => setTone(x.id)}
                >
                  <span className={styles.optionTitle}>{x.label()}</span>
                  <span className={styles.optionHint}>{x.desc()}</span>
                </button>
              ))}
            </div>
            <p className={styles.note}>{t('会写进「记忆 → 关于我」，随时可以修改。')}</p>
          </>
        );
      case 'provider':
        return (
          <>
            <p className={styles.note}>
              {t(
                '添加一个模型服务商（OpenAI 兼容、Anthropic、本机 Ollama 等）。不着急的话可以先跳过，之后在「设置 → 编程助手 → Nomi」里添加。',
              )}
            </p>
            <div className={styles.provider} data-testid="onb-provider">
              <StepBoundary>
                <ModalHostContext.Provider value={INLINE}>
                  <ProviderPanel isVisible onClose={() => undefined} />
                </ModalHostContext.Provider>
              </StepBoundary>
            </div>
          </>
        );
      case 'privacy':
        return (
          <ul className={styles.privacy}>
            <li>
              <Icon icon={Lock} />
              {t('对话、记忆、知识库和屏幕记忆只保存在本机，不做云同步。')}
            </li>
            <li>
              <Icon icon={KeyRound} />
              {t('API 密钥用系统安全存储加密保存，不会上传。')}
            </li>
            <li>
              <Icon icon={Cloud} />
              {t(
                '只有你选择的模型服务商会收到对话内容；第一次把文件或图片发给云端模型前会先问你。',
              )}
            </li>
            <li>
              <Icon icon={FolderLock} />
              {t('她看不到你的文件，除非你逐个文件夹授权；所有操作都有记录，可撤销。')}
            </li>
          </ul>
        );
    }
  })();

  const last = i === STEPS.length - 1;
  return (
    <div className={styles.overlay} data-testid="onboarding" data-step={step}>
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onb-title"
      >
        <header className={styles.head}>
          <div className={styles.dots} aria-label={t('第 {0} 步，共 {1} 步', i + 1, STEPS.length)}>
            {STEPS.map((s, k) => (
              <span
                key={s}
                className={`${styles.dot} ${k === i ? styles.dotOn : ''} ${k < i ? styles.dotDone : ''}`}
              />
            ))}
          </div>
          <button
            type="button"
            className={styles.skipAll}
            data-testid="onboarding-skip-all"
            onClick={() => void finish(true)}
          >
            {t('跳过引导')}
          </button>
        </header>
        <div className={styles.step} key={step} data-testid={`onboarding-step-${step}`}>
          <div className={styles.kicker}>{t('第 {0} 步，共 {1} 步', i + 1, STEPS.length)}</div>
          <h1 id="onb-title" className={styles.title}>
            {STEP_TITLE[step]()}
          </h1>
          <div className={styles.body}>{body}</div>
        </div>
        <footer className={styles.foot}>
          <button
            type="button"
            className={styles.ghost}
            data-testid="onboarding-back"
            disabled={i === 0}
            onClick={() => setI(Math.max(0, i - 1))}
          >
            {t('上一步')}
          </button>
          <span className={styles.grow} />
          {!last && (
            <button
              type="button"
              className={styles.ghost}
              data-testid="onboarding-skip-step"
              onClick={skipStep}
            >
              {t('跳过这一步')}
            </button>
          )}
          <button
            type="button"
            className={styles.primary}
            data-testid={last ? 'onboarding-finish' : 'onboarding-next'}
            onClick={() => void next()}
          >
            {last ? t('开始使用') : t('下一步')}
          </button>
        </footer>
      </div>
    </div>
  );
};

/** 挂在对话窗口根部：未完成引导时显示；设置里「重新打开」也走这里 */
export const OnboardingHost: React.FC = () => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void onboardingClient.get().then((s) => alive && setOpen(!s.done));
    const off = onboardingClient.onShow(() => setOpen(true));
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (!open) return null;
  return <Onboarding onDone={() => setOpen(false)} />;
};
