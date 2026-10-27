/**
 * 首次启动引导：语言 → 主题 → 启动方式 → 角色与声音 → 称呼与语气 → 职业与兴趣 → 供应商 → 隐私。
 * 职业与兴趣存在主进程，侧栏「开始使用」与欢迎页据此推荐任务（services/recommendations）。
 * 每一步都能「跳过这一步」，右上角「跳过引导」直接结束；完成后可在「设置 → 通用」重新打开。
 * 看板娘在引导中打招呼、回应每一步的选择。
 */
import {
  USER_INTERESTS,
  USER_ROLES,
  type UserInterest,
  type UserProfile,
  type UserRole,
} from '@nomi-ai/types';
import {
  THEMES,
  currentTheme,
  getLocale,
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

import { startupClient, type StartupView } from '../../services/startupClient';
import { ModelsPage } from '../ModelsPage';
import { ChatBackgroundSettings } from '../SettingsView/ChatBackgroundSettings';

import { mergePersona, onboardingClient, type VoiceStyle } from './client';
import styles from './index.module.css';

/** 引导里嵌入的面板出错时不影响整个引导（仍可跳过这一步） */
class StepBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className={styles.note}>
        {t('ui.mascot-theme.provider-settings-couldn-t-be-loaded-skip-for')}
      </p>
    ) : (
      this.props.children
    );
  }
}

const STEPS = [
  'language',
  'theme',
  'startup',
  'character',
  'persona',
  'profile',
  'provider',
  'privacy',
] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLE: Record<Step, () => string> = {
  language: () => t('ui.mascot-theme.choose-your-language'),
  theme: () => t('ui.mascot-theme.pick-a-look-you-like'),
  startup: () => t('ui.mascot-theme.what-should-you-see-when-nomi-starts'),
  character: () => t('ui.mascot-theme.pick-a-voice-you-like'),
  persona: () => t('ui.mascot-theme.what-should-she-call-you'),
  profile: () => t('ui.mascot-theme.what-do-you-mostly-do'),
  provider: () => t('ui.mascot-theme.connect-an-ai-model'),
  privacy: () => t('ui.mascot-theme.your-data-stays-on-this-computer'),
};
/** 看板娘在每一步说的话 */
const STEP_LINE: Record<Step, () => string> = {
  language: () => t('ui.mascot-theme.hi-i-m-nomi-your-ai-companion-who'),
  theme: () => t('ui.mascot-theme.pick-a-look-that-feels-comfortable-we-ll'),
  startup: () => t('ui.mascot-theme.should-i-show-up-on-your-desktop-first'),
  character: () => t('ui.mascot-theme.how-should-i-sound-when-i-talk-to'),
  persona: () => t('ui.mascot-theme.tell-me-what-to-call-you-i-ll'),
  profile: () => t('ui.mascot-theme.tell-me-what-you-do-and-i-ll-suggest'),
  provider: () => t('ui.mascot-theme.connect-an-ai-model-and-i-can-help'),
  privacy: () => t('ui.mascot-theme.rest-assured-our-conversations-and-memories-stay-on'),
};

const LANGS: { id: LocalePref; label: () => string; hint: () => string }[] = [
  {
    id: 'system',
    label: () => t('ui.mascot-theme.follow-system'),
    hint: () => t('ui.mascot-theme.matches-your-computer-language'),
  },
  // i18n-ignore
  { id: 'zh-CN', label: () => '中文', hint: () => '简体中文' },
  { id: 'en', label: () => 'English', hint: () => 'English' },
];

const STARTUPS: { id: StartupView; label: () => string; hint: () => string }[] = [
  {
    id: 'mascot',
    label: () => t('ui.mascot-theme.open-with-nomi'),
    hint: () => t('ui.mascot-theme.nomi-appears-on-your-desktop-first-click-her'),
  },
  {
    id: 'main',
    label: () => t('ui.mascot-theme.open-with-the-console-main-window'),
    hint: () => t('ui.mascot-theme.open-the-main-window-right-away-nomi-waits'),
  },
];

const VOICES: { id: VoiceStyle; label: () => string; hint: () => string }[] = [
  {
    id: 'soft',
    label: () => t('ui.mascot-theme.soft'),
    hint: () => t('ui.mascot-theme.gentle-and-quiet'),
  },
  {
    id: 'lively',
    label: () => t('ui.mascot-theme.lively'),
    hint: () => t('ui.mascot-theme.full-of-energy'),
  },
  {
    id: 'calm',
    label: () => t('ui.mascot-theme.calm'),
    hint: () => t('ui.mascot-theme.composed-and-steady'),
  },
  {
    id: 'off',
    label: () => t('ui.mascot-theme.silent'),
    hint: () => t('ui.mascot-theme.bubbles-only'),
  },
];

const TONES: { id: string; label: () => string; desc: () => string }[] = [
  {
    id: 'gentle',
    label: () => t('ui.mascot-theme.warm-caring'),
    desc: () => t('ui.mascot-theme.gentle-tone-attentive-to-you'),
  },
  {
    id: 'lively',
    label: () => t('ui.mascot-theme.cheerful-lively'),
    desc: () => t('ui.mascot-theme.enthusiastic-the-occasional-emoji'),
  },
  {
    id: 'concise',
    label: () => t('ui.mascot-theme.concise-professional'),
    desc: () => t('ui.mascot-theme.straight-to-the-point-little-small-talk'),
  },
  {
    id: 'playful',
    label: () => t('ui.mascot-theme.playful-witty'),
    desc: () => t('ui.mascot-theme.light-hearted-jokes-in-moderation'),
  },
];

const ROLE_LABEL: Record<UserRole, { label: () => string; hint: () => string }> = {
  developer: {
    label: () => t('ui.mascot-theme.role-developer'),
    hint: () => t('ui.mascot-theme.role-developer-hint'),
  },
  product: {
    label: () => t('ui.mascot-theme.role-product'),
    hint: () => t('ui.mascot-theme.role-product-hint'),
  },
  creator: {
    label: () => t('ui.mascot-theme.role-creator'),
    hint: () => t('ui.mascot-theme.role-creator-hint'),
  },
  office: {
    label: () => t('ui.mascot-theme.role-office'),
    hint: () => t('ui.mascot-theme.role-office-hint'),
  },
  student: {
    label: () => t('ui.mascot-theme.role-student'),
    hint: () => t('ui.mascot-theme.role-student-hint'),
  },
  other: {
    label: () => t('ui.mascot-theme.role-other'),
    hint: () => t('ui.mascot-theme.role-other-hint'),
  },
};

const INTEREST_LABEL: Record<UserInterest, () => string> = {
  coding: () => t('ui.mascot-theme.interest-coding'),
  writing: () => t('ui.mascot-theme.interest-writing'),
  language: () => t('ui.mascot-theme.interest-language'),
  learning: () => t('ui.mascot-theme.interest-learning'),
  productivity: () => t('ui.mascot-theme.interest-productivity'),
  automation: () => t('ui.mascot-theme.interest-automation'),
};

export const Onboarding: React.FC<{ onDone: (skipped: boolean) => void }> = ({ onDone }) => {
  useLocale();
  const [i, setI] = useState(0);
  // 引导是阻断式对话框：焦点留在卡片内（Esc 不关闭，需点「跳过引导」）
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef, true);
  const step = STEPS[i]!;
  const [lang, setLang] = useState<LocalePref>(getLocalePref);
  const [theme, setThemeSel] = useState<ThemePref>(() => currentTheme().pref);
  const [voice, setVoice] = useState<VoiceStyle | null>(null);
  const [name, setName] = useState('');
  const [tone, setTone] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [interests, setInterests] = useState<UserInterest[]>([]);
  // 启动方式：默认看板娘（保持历史行为）；点选即写入设置，跳过 / 不选则不改
  const [startup, setStartup] = useState<StartupView>('mascot');

  useEffect(() => {
    void startupClient.get().then(setStartup);
    // 重新引导时带出上次选的职业与兴趣
    void onboardingClient.profile().then((p) => {
      setRole(p.role);
      setInterests(p.interests);
    });
  }, []);
  // 每进入一步，看板娘说一句
  useEffect(() => {
    onboardingClient.mascot({
      type: 'say',
      text: STEP_LINE[step](),
      motion: step === 'language' ? 'wave' : undefined,
    });
  }, [step]);

  /** 称呼、语气、职业与兴趣一起写进「关于我」里引导的那一段；返回是否写了内容 */
  const writePersona = useCallback(async (): Promise<boolean> => {
    const lines: string[] = [];
    if (name.trim()) lines.push(t('ui.mascot-theme.call-me', name.trim().slice(0, 40)));
    const tn = TONES.find((x) => x.id === tone);
    if (tn) lines.push(t('ui.mascot-theme.reply-tone', tn.label(), tn.desc()));
    if (role && role !== 'other')
      lines.push(t('ui.mascot-theme.occupation-line', ROLE_LABEL[role].label()));
    if (interests.length)
      lines.push(
        t(
          'ui.mascot-theme.interests-line',
          interests.map((x) => INTEREST_LABEL[x]()).join(getLocale() === 'en' ? ', ' : '、'),
        ),
      );
    if (!lines.length) return false;
    const cur = await onboardingClient.persona();
    await onboardingClient.setPersona(mergePersona(cur, lines));
    return true;
  }, [name, tone, role, interests]);

  const savePersona = useCallback(async () => {
    if (!(await writePersona())) return;
    onboardingClient.mascot({
      type: 'say',
      text: name.trim()
        ? t('ui.mascot-theme.got-it-that-s-what-i-ll-call', name.trim().slice(0, 40))
        : t('ui.mascot-theme.noted'),
    });
  }, [name, writePersona]);

  const saveProfile = useCallback(async () => {
    const profile: UserProfile = { role, interests };
    await onboardingClient.setProfile(profile);
    if (await writePersona())
      onboardingClient.mascot({ type: 'say', text: t('ui.mascot-theme.noted') });
  }, [role, interests, writePersona]);

  const finish = useCallback(
    async (skipped: boolean) => {
      await onboardingClient.complete(skipped);
      onboardingClient.mascot({
        type: 'say',
        text: skipped
          ? t('ui.mascot-theme.you-can-reopen-this-guide-from-settings-anytime')
          : t('ui.mascot-theme.all-set-i-m-here-to-help-turn'),
        motion: skipped ? undefined : 'cheer',
      });
      onDone(skipped);
    },
    [onDone],
  );

  const next = async () => {
    if (step === 'persona') await savePersona();
    if (step === 'profile') await saveProfile();
    if (i === STEPS.length - 1) return finish(false);
    setI(i + 1);
  };
  const skipStep = () => (i === STEPS.length - 1 ? void finish(false) : setI(i + 1));

  const body = (() => {
    switch (step) {
      case 'language':
        return (
          <div
            className={styles.options}
            role="radiogroup"
            aria-label={t('ui.voice-mascot.language')}
          >
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
        const main = THEMES.filter((x) => x.id === 'sunset' || x.id === 'system');
        const more = THEMES.filter((x) => x.id !== 'sunset' && x.id !== 'system');
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
            <div
              className={styles.options}
              role="radiogroup"
              aria-label={t('ui.chat-settings.theme')}
            >
              {main.map((x) => card(x, true))}
            </div>
            <div className={styles.subLabel}>{t('ui.mascot-theme.more-colors')}</div>
            <div className={styles.options}>{more.map((x) => card(x, false))}</div>
            {theme === 'image' && <ChatBackgroundSettings />}
          </>
        );
      }
      case 'startup':
        return (
          <>
            <div
              className={styles.options}
              role="radiogroup"
              aria-label={t('ui.mascot-theme.startup-mode')}
            >
              {STARTUPS.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={startup === x.id}
                  data-testid={`onb-startup-${x.id}`}
                  className={`${styles.option} ${startup === x.id ? styles.optionOn : ''}`}
                  onClick={() => {
                    const prev = startup;
                    setStartup(x.id);
                    void startupClient.set(x.id).then((saved) => setStartup(saved ?? prev));
                  }}
                >
                  <span className={styles.optionTitle}>{x.label()}</span>
                  <span className={styles.optionHint}>{x.hint()}</span>
                </button>
              ))}
            </div>
            <p className={styles.note}>
              {t('ui.mascot-theme.if-you-rely-on-scheduled-tasks-reminders-nomi')}
              {t('ui.mascot-theme.you-can-change-this-any-time-in-settings')}
            </p>
          </>
        );
      case 'character':
        return (
          <>
            <div
              className={styles.options}
              role="radiogroup"
              aria-label={t('ui.mascot-theme.voice')}
            >
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
                      preview:
                        v.id === 'off'
                          ? undefined
                          : t('ui.mascot-theme.hi-i-m-nomi-let-s-make-today'),
                    });
                  }}
                >
                  <span className={styles.optionTitle}>{v.label()}</span>
                  <span className={styles.optionHint}>{v.hint()}</span>
                </button>
              ))}
            </div>
            <p className={styles.note}>
              {t('ui.mascot-theme.click-to-preview-fine-tune-later-in-settings')}
            </p>
          </>
        );
      case 'persona':
        return (
          <>
            <label className={styles.field}>
              <span className={styles.subLabel}>{t('ui.mascot-theme.name')}</span>
              <input
                className={styles.input}
                data-testid="onb-name"
                value={name}
                maxLength={40}
                placeholder={t('ui.mascot-theme.e-g-lin-boss-your-name')}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void next()}
              />
            </label>
            <div className={styles.subLabel}>{t('ui.mascot-theme.speaking-tone')}</div>
            <div
              className={styles.options}
              role="radiogroup"
              aria-label={t('ui.mascot-theme.speaking-tone')}
            >
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
            <p className={styles.note}>
              {t('ui.mascot-theme.saved-to-memory-about-me-you-can-change')}
            </p>
          </>
        );
      case 'profile':
        return (
          <>
            <div className={styles.subLabel}>{t('ui.mascot-theme.occupation')}</div>
            <div
              className={styles.options}
              role="radiogroup"
              aria-label={t('ui.mascot-theme.occupation')}
            >
              {USER_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={role === r}
                  data-testid={`onb-role-${r}`}
                  className={`${styles.option} ${styles.optionSmall} ${role === r ? styles.optionOn : ''}`}
                  onClick={() => setRole(r)}
                >
                  <span className={styles.optionTitle}>{ROLE_LABEL[r].label()}</span>
                  <span className={styles.optionHint}>{ROLE_LABEL[r].hint()}</span>
                </button>
              ))}
            </div>
            <div className={styles.subLabel} id="onb-interests-label">
              {t('ui.mascot-theme.interests-pick-any')}
            </div>
            <div className={styles.options} role="group" aria-labelledby="onb-interests-label">
              {USER_INTERESTS.map((x) => {
                const on = interests.includes(x);
                return (
                  <button
                    key={x}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    data-testid={`onb-interest-${x}`}
                    className={`${styles.option} ${styles.optionSmall} ${on ? styles.optionOn : ''}`}
                    onClick={() =>
                      setInterests((cur) =>
                        on
                          ? cur.filter((y) => y !== x)
                          : USER_INTERESTS.filter((y) => y === x || cur.includes(y)),
                      )
                    }
                  >
                    <span className={styles.optionTitle}>{INTEREST_LABEL[x]()}</span>
                  </button>
                );
              })}
            </div>
            <p className={styles.note}>
              {t('ui.mascot-theme.i-ll-suggest-coding-agents-example-questions')}
            </p>
          </>
        );
      case 'provider':
        return (
          <>
            <p className={styles.note}>
              {t('ui.cli-monitor.add-a-third-party-provider-a-model-vendor')}
            </p>
            <div className={styles.provider} data-testid="onb-provider">
              <StepBoundary>
                <ModelsPage />
              </StepBoundary>
            </div>
          </>
        );
      case 'privacy':
        return (
          <ul className={styles.privacy}>
            <li>
              <Icon icon={Lock} />
              {t('ui.mascot-theme.chats-memories-and-the-knowledge-base-stay-local')}
            </li>
            <li>
              <Icon icon={KeyRound} />
              {t('ui.mascot-theme.api-keys-are-encrypted-with-the-system-secure')}
            </li>
            <li>
              <Icon icon={Cloud} />
              {t('ui.mascot-theme.only-the-model-provider-you-choose-receives-your')}
            </li>
            <li>
              <Icon icon={FolderLock} />
              {t('ui.mascot-theme.she-can-t-see-your-files-unless-you')}
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
          <div
            className={styles.dots}
            aria-label={t('ui.mascot-theme.step-of', i + 1, STEPS.length)}
          >
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
            {t('ui.mascot-theme.skip-guide')}
          </button>
        </header>
        <div className={styles.step} key={step} data-testid={`onboarding-step-${step}`}>
          <div className={styles.kicker}>{t('ui.mascot-theme.step-of', i + 1, STEPS.length)}</div>
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
            {t('ui.mascot-theme.back')}
          </button>
          <span className={styles.grow} />
          {!last && (
            <button
              type="button"
              className={styles.ghost}
              data-testid="onboarding-skip-step"
              onClick={skipStep}
            >
              {t('ui.mascot-theme.skip-this-step')}
            </button>
          )}
          <button
            type="button"
            className={styles.primary}
            data-testid={last ? 'onboarding-finish' : 'onboarding-next'}
            onClick={() => void next()}
          >
            {last ? t('ui.mascot-theme.get-started') : t('ui.mascot-theme.next')}
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
