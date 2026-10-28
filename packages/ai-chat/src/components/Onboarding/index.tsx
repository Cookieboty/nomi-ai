/**
 * 首次启动引导：欢迎与语言 → 外观与启动 → 关于你（称呼、职业与兴趣）→ 接上模型 → 隐私与完成。
 * 职业与兴趣存在主进程，侧栏「开始使用」与欢迎页据此推荐任务（services/recommendations）。
 * 每一步都能「跳过这一步」，右上角「跳过引导」直接结束；完成后可在「设置 → 通用」重新打开。
 * 看板娘在引导中打招呼、回应每一步的选择；还没接上模型时，最后一步与她的台词都会提醒「还差一步」。
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
import { CheckCircle2, Cloud, FolderLock, KeyRound, Lock, PlugZap } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useNomiModelStatus } from '../../hooks/useNomiModelStatus';
import { startupClient, type StartupView } from '../../services/startupClient';
import { ChatBackgroundSettings } from '../SettingsView/ChatBackgroundSettings';

import { BUILTIN_ONBOARDING_ART, resolveOnboardingArt } from './artUrls';
import {
  OPEN_MODELS_EVENT,
  matchTemplate,
  mergePersona,
  onboardingClient,
  personaBlockLines,
} from './client';
import styles from './index.module.css';
import { ProviderSetup } from './ProviderSetup';

const STEPS = ['welcome', 'profile', 'provider', 'privacy'] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLE: Record<Step, () => string> = {
  welcome: () => t('ui.mascot-theme.welcome-title'),
  profile: () => t('ui.mascot-theme.about-you'),
  provider: () => t('ui.mascot-theme.connect-an-ai-model'),
  privacy: () => t('ui.mascot-theme.your-data-stays-on-this-computer'),
};
/** 看板娘在每一步说的话（最后一步视模型状态而定，见 lineFor） */
const STEP_LINE: Record<Step, () => string> = {
  welcome: () => t('ui.mascot-theme.hi-i-m-nomi-your-ai-companion-who'),
  profile: () => t('ui.mascot-theme.tell-me-what-you-do-and-i-ll-suggest'),
  provider: () => t('ui.mascot-theme.connect-an-ai-model-and-i-can-help'),
  privacy: () => t('ui.mascot-theme.rest-assured-our-conversations-and-memories-stay-on'),
};
/** 带插画的步骤：插画 + 一句介绍（窗口很矮时插画隐藏） */
const STEP_ART_META: Record<Step, { intro?: () => string }> = {
  welcome: { intro: () => t('ui.mascot-theme.intro-welcome') },
  profile: { intro: () => t('ui.mascot-theme.intro-profile') },
  provider: { intro: () => t('ui.mascot-theme.intro-provider') },
  privacy: {},
};

const LANGS: { id: LocalePref; label: () => string }[] = [
  { id: 'system', label: () => t('ui.mascot-theme.follow-system') },
  // i18n-ignore
  { id: 'zh-CN', label: () => '简体中文' },
  { id: 'en', label: () => 'English' },
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

/** 早期引导写的「回答语气」行：这个功能已删除，重写引导那一段时丢掉 */
const DROPPED_TONE_LINE = /^- (回答语气|Reply tone)[:：]/;

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
  // 等角色包 overlay 解析完再出插画，避免先闪一下内置插画再换成角色包的
  const [stepArt, setStepArt] = useState<Record<Step, string> | null>(null);
  useEffect(() => {
    let alive = true;
    void resolveOnboardingArt().then((art) => {
      if (alive) setStepArt(art);
    });
    return () => {
      alive = false;
    };
  }, []);

  const [i, setI] = useState(0);
  // 引导是阻断式对话框：焦点留在卡片内（Esc 不关闭，需点「跳过引导」）
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef, true);
  const step = STEPS[i]!;
  const model = useNomiModelStatus();
  const modelReady = model === 'ready';
  const [lang, setLang] = useState<LocalePref>(getLocalePref);
  const [theme, setThemeSel] = useState<ThemePref>(() => currentTheme().pref);
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole | null>(null);
  const [interests, setInterests] = useState<UserInterest[]>([]);
  // 启动方式：默认看板娘（保持历史行为）；点选即写入设置，跳过 / 不选则不改
  const [startup, setStartup] = useState<StartupView>('mascot');
  /** 「关于我」里引导那一段中认不出的行（手改的、换语言前写的）：重写时原样保留 */
  const keepLines = useRef<string[]>([]);
  const loaded = useRef<Promise<void> | null>(null);

  useEffect(() => {
    void startupClient.get().then(setStartup);
    // 重新引导时带出上次选的职业与兴趣
    const profile = onboardingClient.profile().then((p) => {
      setRole(p.role);
      setInterests(p.interests);
    });
    // 以及上次填的称呼（跳过这一步也不会把它清掉）
    const persona = onboardingClient.persona().then((text) => {
      const keep: string[] = [];
      for (const line of personaBlockLines(text)) {
        const callMe = matchTemplate(t('ui.mascot-theme.call-me'), line);
        if (callMe) setName(callMe[0]!);
        else if (
          !DROPPED_TONE_LINE.test(line) &&
          !matchTemplate(t('ui.mascot-theme.occupation-line'), line) &&
          !matchTemplate(t('ui.mascot-theme.interests-line'), line)
        )
          keep.push(line);
      }
      keepLines.current = keep;
    });
    loaded.current = Promise.all([profile, persona]).then(() => undefined);
  }, []);
  // 每进入一步，看板娘说一句；最后一步还没接上模型时提醒「还差一步」
  const line =
    step === 'privacy' && !modelReady ? t('ui.mascot-theme.one-step-left-line') : STEP_LINE[step]();
  useEffect(() => {
    onboardingClient.mascot({
      type: 'say',
      text: line,
      gesture: step === 'welcome' ? 'wave' : undefined,
    });
  }, [step, line]);

  /** 称呼、职业与兴趣一起写进「关于我」里引导的那一段；返回是否写了内容 */
  const writePersona = useCallback(async (): Promise<boolean> => {
    await loaded.current;
    const lines: string[] = [];
    if (name.trim()) lines.push(t('ui.mascot-theme.call-me', name.trim().slice(0, 40)));
    if (role && role !== 'other')
      lines.push(t('ui.mascot-theme.occupation-line', ROLE_LABEL[role].label()));
    if (interests.length)
      lines.push(
        t(
          'ui.mascot-theme.interests-line',
          interests.map((x) => INTEREST_LABEL[x]()).join(getLocale() === 'en' ? ', ' : '、'),
        ),
      );
    const cur = await onboardingClient.persona();
    const merged = mergePersona(cur, [...lines, ...keepLines.current]);
    if (merged !== cur.trim()) await onboardingClient.setPersona(merged);
    return lines.length > 0;
  }, [name, role, interests]);

  const saveProfile = useCallback(async () => {
    const profile: UserProfile = { role, interests };
    await onboardingClient.setProfile(profile);
    if (!(await writePersona())) return;
    onboardingClient.mascot({
      type: 'say',
      text: name.trim()
        ? t('ui.mascot-theme.got-it-that-s-what-i-ll-call', name.trim().slice(0, 40))
        : t('ui.mascot-theme.noted'),
    });
  }, [name, role, interests, writePersona]);

  const finish = useCallback(
    async (skipped: boolean) => {
      await onboardingClient.complete(skipped);
      onboardingClient.mascot({
        type: 'say',
        text: skipped
          ? t('ui.mascot-theme.you-can-reopen-this-guide-from-settings-anytime')
          : modelReady
            ? t('ui.mascot-theme.all-set-i-m-here-to-help-turn')
            : t('ui.mascot-theme.one-step-left-line'),
        gesture: skipped || !modelReady ? undefined : 'cheer',
      });
      onDone(skipped);
    },
    [onDone, modelReady],
  );
  /** 去设置里接模型：结束引导（算完成）再打开「设置 → 模型与供应商」 */
  const openModels = () => {
    void finish(false).then(() => window.dispatchEvent(new CustomEvent(OPEN_MODELS_EVENT)));
  };

  // 保存（写 persona / 职业与兴趣）期间不能再前进 / 后退 / 跳过，否则会连跳两步或丢掉正在写的内容
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const next = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (step === 'profile') await saveProfile();
      if (i === STEPS.length - 1) return await finish(false);
      setI(i + 1);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const skipStep = () => {
    if (savingRef.current) return;
    if (i === STEPS.length - 1) void finish(false);
    else setI(i + 1);
  };

  const body = (() => {
    switch (step) {
      case 'welcome': {
        // 默认的日落橙与跟随系统排在前面；全部做成小卡片，一屏内能看到启动方式
        const themes = [
          ...THEMES.filter((x) => x.id === 'sunset' || x.id === 'system'),
          ...THEMES.filter((x) => x.id !== 'sunset' && x.id !== 'system'),
        ];
        const card = (x: (typeof THEMES)[number]) => (
          <button
            key={x.id}
            type="button"
            role="radio"
            aria-checked={theme === x.id}
            data-testid={`onb-theme-${x.id}`}
            className={`${styles.option} ${styles.optionSmall} ${theme === x.id ? styles.optionOn : ''}`}
            title={t(x.desc)}
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
          </button>
        );
        return (
          <>
            <div className={styles.subLabel}>{t('ui.mascot-theme.choose-your-language')}</div>
            <div
              className={styles.segmented}
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
                  className={`${styles.segment} ${lang === l.id ? styles.segmentOn : ''}`}
                  onClick={() => {
                    setLang(l.id);
                    void setLocalePref(l.id);
                  }}
                >
                  {l.label()}
                </button>
              ))}
            </div>

            <div className={styles.subLabel}>{t('ui.chat-settings.theme')}</div>

            <div
              className={`${styles.options} ${styles.optionsDense}`}
              role="radiogroup"
              aria-label={t('ui.chat-settings.theme')}
            >
              {themes.map(card)}
            </div>
            {theme === 'image' && <ChatBackgroundSettings />}

            <div className={styles.subLabel}>{t('ui.mascot-theme.startup-mode')}</div>

            <div
              className={`${styles.options} ${styles.optionsPair}`}
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
                  className={`${styles.option} ${styles.optionSmall} ${startup === x.id ? styles.optionOn : ''}`}
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
              {t('ui.mascot-theme.you-can-change-this-any-time-in-settings')}
            </p>
          </>
        );
      }
      case 'profile':
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
        return <ProviderSetup onOpenModels={openModels} />;
      case 'privacy':
        return (
          <>
            {modelReady ? (
              <div className={`${styles.callout} ${styles.calloutOk}`} data-testid="onb-all-set">
                <Icon icon={CheckCircle2} />
                <div>
                  <div className={styles.calloutTitle}>{t('ui.mascot-theme.all-set-title')}</div>
                  <div className={styles.note}>{t('ui.mascot-theme.all-set-hint')}</div>
                </div>
              </div>
            ) : (
              <div className={styles.callout} data-testid="onb-one-step-left">
                <Icon icon={PlugZap} />
                <div className={styles.grow}>
                  <div className={styles.calloutTitle}>{t('ui.mascot-theme.one-step-left')}</div>
                  <div className={styles.note}>{t('ui.mascot-theme.one-step-left-hint')}</div>
                </div>
                <button
                  type="button"
                  className={styles.secondary}
                  data-testid="onb-go-models"
                  onClick={openModels}
                >
                  {t('ui.mascot-theme.go-connect-model')}
                </button>
              </div>
            )}
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
          </>
        );
    }
  })();

  const last = i === STEPS.length - 1;
  const artSrc = stepArt ? (stepArt[step] ?? BUILTIN_ONBOARDING_ART[step]) : null;
  const artIntro = STEP_ART_META[step]?.intro;
  return (
    <div className={styles.overlay} data-testid="onboarding" data-step={step}>
      <div
        ref={cardRef}
        className={`${styles.card} ${styles.cardArt}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onb-title"
      >
        {/* 插画铺满整张卡片做背景，人物靠右完整显示；没有插画的步骤用欢迎图的淡化版 */}
        <div
          className={styles.bg}
          style={artSrc ? { backgroundImage: `url(${artSrc})` } : undefined}
          aria-hidden
          data-testid="onb-art"
          data-art={step}
        />
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
          {artIntro && <p className={styles.intro}>{artIntro()}</p>}
          <div className={styles.body}>{body}</div>
        </div>
        <footer className={styles.foot}>
          <button
            type="button"
            className={styles.ghost}
            data-testid="onboarding-back"
            disabled={i === 0 || saving}
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
              disabled={saving}
              onClick={skipStep}
            >
              {t('ui.mascot-theme.skip-this-step')}
            </button>
          )}
          <button
            type="button"
            className={styles.primary}
            data-testid={last ? 'onboarding-finish' : 'onboarding-next'}
            disabled={saving}
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
