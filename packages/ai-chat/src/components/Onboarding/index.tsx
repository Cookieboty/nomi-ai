/**
 * 首次启动引导，三步：
 *   1. 语言和外观；
 *   2. AI 能力：agents（检测本机、没装的就地安装，用自己的账号登录）+ 对话模型（第三方供应商，可选）；
 *   3. 个性化：称呼、职业与兴趣、启动方式（都可选）。
 * 职业与兴趣存在主进程，侧栏「开始使用」与欢迎页据此推荐任务（services/recommendations）。
 * 填过的称呼、职业与兴趣在结束时一起保存（「跳过引导」也保存；没改过就不写）。
 * 结束后装了 agent 的进看板，一个都没装的留在对话。右上角「跳过引导」直接结束；
 * 完成后可在「设置 → 通用」重新打开。引导盖住整个窗口；桌面角色只有被打开时才说话。
 */
import { cliName } from '@nomi-ai/cli-catalog';
import {
  USER_INTERESTS,
  USER_ROLES,
  type UserInterest,
  type UserRole,
  type UserProfile,
} from '@nomi-ai/types';
import {
  Badge,
  Button,
  Icon,
  Input,
  SegmentedControl,
  THEMES,
  currentTheme,
  getLocale,
  getLocalePref,
  setLocalePref,
  setTheme,
  t,
  tName,
  useFocusTrap,
  useLocale,
  type LocalePref,
  type ThemePref,
} from '@nomi-ai/ui';
import {
  IconBook2 as BookOpen,
  IconMessageChatbot as BotMessageSquare,
  IconPackages as Boxes,
  IconBriefcase as Briefcase,
  IconCalendarCheck as CalendarCheck2,
  IconCheck as Check,
  IconCircleCheck as CheckCircle2,
  IconCloud as Cloud,
  IconCode as Code2,
  IconCompass as Compass,
  IconFeather as Feather,
  IconSchool as GraduationCap,
  IconKey as KeyRound,
  IconLanguage as Languages,
  IconLayoutSidebar as LayoutPanelLeft,
  IconLock as Lock,
  IconPlug as Plug,
  IconSparkles as Sparkles,
  type TablerIcon as IconGlyph,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import { useNomiModelStatus } from '../../hooks/useNomiModelStatus';
import { characterName, useCharacterName } from '../../services/characterName';
import { startupClient, type StartupView } from '../../services/startupClient';
import { requestOpenFleet } from '../../services/workbenchNav';
import { isImeComposing } from '../../utils/keyboard';
import { BrandLockup } from '../BrandIntro/BrandLockup';
import { introActive, introHolding, startupBrandIntro, useBrandIntro } from '../BrandIntro/state';
import { DISPATCH_CLIS } from '../DispatchCli';
import { EndpointIcon } from '../EndpointIcon';
import { useCliInstall } from '../ModelsPage/useCliInstall';
import { ChatBackgroundSettings } from '../SettingsView/ChatBackgroundSettings';
import { ThemeChoice, ThemeMiniature } from '../ThemeChoice';

import {
  OPEN_MODELS_EVENT,
  matchTemplate,
  mergePersona,
  onboardingClient,
  personaBlockLines,
} from './client';
import styles from './index.module.css';
import choiceStyles from './PersonalChoices.module.css';
import { ProviderSetup } from './ProviderSetup';

const STEPS = ['welcome', 'ai', 'personal'] as const;
type Step = (typeof STEPS)[number];

/** 步骤条上的短名 */
const STEP_NAME: Record<Step, () => string> = {
  welcome: () => t('ui.mascot-theme.onb-step-welcome'),
  ai: () => t('ui.mascot-theme.onb-step-ai'),
  personal: () => t('ui.mascot-theme.onb-step-personal'),
};
const STEP_TITLE: Record<Step, () => string> = {
  welcome: () => t('ui.mascot-theme.onb-welcome-title'),
  ai: () => t('ui.mascot-theme.onb-ai-title'),
  personal: () => t('ui.mascot-theme.onb-personal-title'),
};
const STEP_INTRO: Record<Step, () => string> = {
  welcome: () => t('ui.mascot-theme.onb-welcome-intro'),
  ai: () => t('ui.mascot-theme.onb-ai-intro'),
  personal: () => t('ui.mascot-theme.onb-personal-intro'),
};
/** 桌面角色被打开时，每一步说的一句。关着时不说。 */
const STEP_LINE: Record<Step, () => string> = {
  welcome: () => t('ui.mascot-theme.onb-line-welcome'),
  ai: () => t('ui.mascot-theme.onb-line-ai'),
  personal: () => t('ui.mascot-theme.onb-line-personal'),
};

/** 一组表单：标题 + 一句说明 + 内容 */
const Group: React.FC<{
  title: string;
  desc?: string;
  id?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ title, desc, id, className = '', children }) => (
  <section className={`${styles.group} ${className}`} aria-labelledby={id}>
    <div className={styles.groupHead}>
      <h2 className={styles.groupTitle} id={id}>
        {title}
      </h2>
      {desc && <p className={styles.groupDesc}>{desc}</p>}
    </div>
    {children}
  </section>
);

/** 光标随动微光：通过 CSS 变量 --mx / --my 零重渲染驱动局部聚光灯 */
const trackSpotlight = (e: React.PointerEvent<HTMLElement>) => {
  const rect = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`);
  e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`);
};

/** 卡片整体环境聚光灯 */
const trackCanvasSpotlight = (e: React.PointerEvent<HTMLDivElement>) => {
  const rect = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--cx', `${e.clientX - rect.left}px`);
  e.currentTarget.style.setProperty('--cy', `${e.clientY - rect.top}px`);
};

/** 波浪入场索引样式 */
const stagger = (index: number): CSSProperties => ({ '--onb-i': index }) as CSSProperties;

/** 可选中的交互卡片（主题、职业、启动方式）：极简紧凑单/双行卡片 + 光标微光 + 选中微缩放 */
const OptionCard: React.FC<{
  on: boolean;
  role: 'radio' | 'checkbox';
  testId: string;
  title: string;
  hint?: string;
  preview?: React.ReactNode;
  icon?: React.ReactNode;
  compact?: boolean;
  hideCheck?: boolean;
  index?: number;
  className?: string;
  iconClassName?: string;
  onClick: () => void;
}> = ({
  on,
  role,
  testId,
  title,
  hint,
  preview,
  icon,
  compact,
  hideCheck,
  index,
  className = '',
  iconClassName = '',
  onClick,
}) => (
  <button
    type="button"
    role={role}
    aria-checked={on}
    data-testid={testId}
    className={`${styles.option} ${compact ? styles.optionCompact : ''} ${on ? styles.optionOn : ''} ${className}`}
    style={index === undefined ? undefined : stagger(index)}
    onPointerMove={trackSpotlight}
    onClick={onClick}
  >
    {preview}
    {icon && <span className={`${styles.optionIcon} ${iconClassName}`}>{icon}</span>}
    <span className={styles.optionText}>
      <span className={styles.optionTitle}>{title}</span>
      {hint && <span className={styles.optionHint}>{hint}</span>}
    </span>
    {!hideCheck && (
      <span className={styles.optionCheck} aria-hidden>
        <Check size={13} strokeWidth={2.75} />
      </span>
    )}
  </button>
);

const LANGS: { id: LocalePref; label: () => string }[] = [
  { id: 'system', label: () => t('ui.mascot-theme.follow-system') },
  // i18n-ignore
  { id: 'zh-CN', label: () => '简体中文' },
  { id: 'en', label: () => 'English' },
];

const STARTUPS: { id: StartupView; label: () => string; hint: () => string }[] = [
  {
    id: 'main',
    label: () => t('ui.mascot-theme.onb-startup-workbench'),
    hint: () => t('ui.mascot-theme.onb-startup-workbench-hint'),
  },
  {
    id: 'mascot',
    label: () => tName('ui.mascot-theme.onb-startup-character', characterName()),
    hint: () => tName('ui.mascot-theme.onb-startup-character-hint', characterName()),
  },
];

/** 早期引导写的「回答语气」行：这个功能已删除，重写引导那一段时丢掉 */
const DROPPED_TONE_LINE = /^- (回答语气|Reply tone)[:：]/;

const ROLE_LABEL: Record<UserRole, { label: () => string; hint: () => string; icon: IconGlyph }> = {
  developer: {
    label: () => t('ui.mascot-theme.role-developer'),
    hint: () => t('ui.mascot-theme.role-developer-hint'),
    icon: Code2,
  },
  product: {
    label: () => t('ui.mascot-theme.role-product'),
    hint: () => t('ui.mascot-theme.role-product-hint'),
    icon: Compass,
  },
  creator: {
    label: () => t('ui.mascot-theme.role-creator'),
    hint: () => t('ui.mascot-theme.role-creator-hint'),
    icon: Feather,
  },
  office: {
    label: () => t('ui.mascot-theme.role-office'),
    hint: () => t('ui.mascot-theme.role-office-hint'),
    icon: Briefcase,
  },
  student: {
    label: () => t('ui.mascot-theme.role-student'),
    hint: () => t('ui.mascot-theme.role-student-hint'),
    icon: GraduationCap,
  },
  other: {
    label: () => t('ui.mascot-theme.role-other'),
    hint: () => t('ui.mascot-theme.role-other-hint'),
    icon: Sparkles,
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

const INTEREST_ICON: Record<UserInterest, IconGlyph> = {
  coding: Code2,
  writing: Feather,
  language: Languages,
  learning: BookOpen,
  productivity: CalendarCheck2,
  automation: Plug,
};

const EXIT_MS = 140;
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const Onboarding: React.FC<{ onDone: (skipped: boolean) => void }> = ({ onDone }) => {
  useLocale();
  const intro = useBrandIntro();
  const introBrandRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    startupBrandIntro.setTarget(introBrandRef.current);
    return () => startupBrandIntro.setTarget(null);
  }, []);
  const [i, setI] = useState(0);
  const [navI, setNavI] = useState(0);
  const [dir, setDir] = useState<'next' | 'prev'>('next');
  const [phase, setPhase] = useState<'in' | 'out'>('in');
  const targetStepRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 引导是阻断式对话框：焦点留在卡片内（Esc 不关闭，需点「跳过引导」）
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef, true);
  const step = STEPS[i]!;
  // 角色名到达 / 变化时重新渲染（标题与桌面角色台词里有它）
  useCharacterName();
  const model = useNomiModelStatus();
  const modelReady = model === 'ready';
  const [lang, setLang] = useState<LocalePref>(getLocalePref);
  const [theme, setThemeSel] = useState<ThemePref>(() => currentTheme().pref);
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole | null>(null);
  const [interests, setInterests] = useState<UserInterest[]>([]);
  /** 用户改过称呼 / 职业 / 兴趣：结束时（含「跳过引导」）才写，没改过不动已有的 */
  const profileTouched = useRef(false);
  const [cliError, setCliError] = useState('');
  /** 对话模型那一组默认收起（供应商列表很长，会把 agent 挤出首屏）；已经接好模型的直接展开 */
  const [modelOpen, setModelOpen] = useState(false);
  const cli = useCliInstall(setCliError, { layer: 'top' });
  // 启动方式：默认打开工作台，桌面角色关着。点选即写入设置。
  const [startup, setStartup] = useState<StartupView>('main');
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
  // 桌面角色开着时，每进入一步说一句。关着时不说话。
  const line = STEP_LINE[step]();
  useEffect(() => {
    if (startup !== 'mascot') return;
    onboardingClient.mascot({
      type: 'say',
      text: line,
      gesture: step === 'welcome' ? 'wave' : undefined,
    });
  }, [step, line, startup]);

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
    if (startup !== 'mascot') return;
    onboardingClient.mascot({
      type: 'say',
      text: name.trim()
        ? t('ui.mascot-theme.got-it-that-s-what-i-ll-call', name.trim().slice(0, 40))
        : t('ui.mascot-theme.noted'),
    });
  }, [name, role, interests, writePersona, startup]);

  const finish = useCallback(
    async (skipped: boolean, opts?: { board?: boolean }) => {
      if (profileTouched.current) await saveProfile();
      await onboardingClient.complete(skipped);
      if (startup === 'mascot') {
        onboardingClient.mascot({
          type: 'say',
          text: skipped
            ? t('ui.mascot-theme.you-can-reopen-this-guide-from-settings-anytime')
            : modelReady
              ? t('ui.mascot-theme.onb-line-done')
              : t('ui.mascot-theme.onb-line-need-model'),
          gesture: skipped || !modelReady ? undefined : 'cheer',
        });
      }
      onDone(skipped);
      // 装了 agent：进看板（空看板上就是派出按钮）；一个都没装：留在对话，「开始使用」清单接着引导
      if (opts?.board !== false && cli.anyInstalled) requestOpenFleet();
    },
    [onDone, modelReady, startup, saveProfile, cli.anyInstalled],
  );
  /** 去设置里接模型：结束引导（算完成）再打开「设置 → 模型与供应商」 */
  const openModels = () => {
    void finish(false, { board: false }).then(() =>
      window.dispatchEvent(new CustomEvent(OPEN_MODELS_EVENT)),
    );
  };

  const commitStep = useCallback((idx: number) => {
    targetStepRef.current = null;
    exitTimerRef.current = null;
    setI(idx);
    setNavI(idx);
    setPhase('in');
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  const goToStep = useCallback(
    (nextIndex: number) => {
      const clamped = Math.max(0, Math.min(nextIndex, STEPS.length - 1));
      const base = targetStepRef.current ?? i;
      if (clamped === base) return;
      setDir(clamped > base ? 'next' : 'prev');
      setNavI(clamped);
      if (prefersReducedMotion()) {
        if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
        commitStep(clamped);
        return;
      }
      targetStepRef.current = clamped;
      setPhase('out');
      if (exitTimerRef.current !== null) return;
      exitTimerRef.current = window.setTimeout(() => {
        commitStep(targetStepRef.current ?? clamped);
      }, EXIT_MS);
    },
    [commitStep, i],
  );

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    },
    [],
  );

  // 保存（写 persona / 职业与兴趣）期间不能再前进 / 后退 / 跳过，否则会连跳两步或丢掉正在写的内容
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const next = async () => {
    if (savingRef.current) return;
    const cur = targetStepRef.current ?? i;
    if (cur < STEPS.length - 1) {
      goToStep(cur + 1);
      return;
    }
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      commitStep(cur);
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await finish(false);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const skipStep = () => {
    if (savingRef.current) return;
    const cur = targetStepRef.current ?? i;
    goToStep(Math.min(cur + 1, STEPS.length - 1));
  };
  const nextRef = useRef(next);
  useEffect(() => {
    nextRef.current = next;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
      if (isImeComposing(e) || savingRef.current) return;
      if (document.querySelector('[role="alertdialog"], .cd-modal-overlay')) return;
      e.preventDefault();
      void nextRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const touch = () => {
    profileTouched.current = true;
  };

  const body = (() => {
    switch (step) {
      case 'welcome': {
        // 第一排：跟随系统、浅色、深色；第二排：亮色主题；第三排：暗色主题
        const order: readonly ThemePref[] = [
          'system',
          'light',
          'dark',
          'sunset',
          'cream',
          'mist',
          'ink',
          'graphite',
          'image',
        ];
        const themes = [...THEMES].sort((a, b) => {
          const ia = order.indexOf(a.id);
          const ib = order.indexOf(b.id);
          return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
        });
        return (
          <>
            <Group title={t('ui.voice-mascot.language')}>
              <SegmentedControl<LocalePref>
                aria-label={t('ui.voice-mascot.language')}
                className={styles.segmented}
                value={lang}
                options={LANGS.map((l) => ({
                  value: l.id,
                  label: l.label(),
                  testId: `onb-lang-${l.id}`,
                }))}
                onChange={(v) => {
                  setLang(v);
                  void setLocalePref(v);
                }}
              />
            </Group>
            <Group title={t('ui.chat-settings.theme')} id="onb-theme-label">
              <div
                className={`${styles.options} ${styles.optionsThemes}`}
                role="radiogroup"
                aria-labelledby="onb-theme-label"
              >
                {themes.map((x, idx) => (
                  <ThemeChoice
                    key={x.id}
                    className={styles.themeChoice}
                    style={stagger(idx)}
                    selected={theme === x.id}
                    testId={`onb-theme-${x.id}`}
                    label={t(x.name)}
                    preview={<ThemeMiniature swatch={x.swatch} system={x.id === 'system'} />}
                    onPick={() => {
                      setThemeSel(x.id);
                      void setTheme(x.id);
                    }}
                  />
                ))}
              </div>
              {theme === 'image' && (
                <div className={styles.revealPanel}>
                  <ChatBackgroundSettings />
                </div>
              )}
            </Group>
          </>
        );
      }
      case 'ai':
        return (
          <>
            <Group
              title={t('ui.mascot-theme.onb-section-agents')}
              desc={t('ui.mascot-theme.onb-agents-group-desc')}
            >
              <ul className={styles.list}>
                {DISPATCH_CLIS.map((id, idx) => {
                  const installed = cli.installed(id);
                  return (
                    <li
                      key={id}
                      className={styles.listRow}
                      style={stagger(idx)}
                      data-testid={`onb-agent-${id}`}
                      onPointerMove={trackSpotlight}
                    >
                      <span className={styles.listIcon}>
                        <EndpointIcon backend={id} size={18} decorative />
                      </span>
                      <span className={styles.listName}>{cliName(id)}</span>
                      {installed ? (
                        <Badge
                          tone="success"
                          icon={CheckCircle2}
                          data-testid={`onb-agent-${id}-installed`}
                        >
                          {t('ui.knowledge-local.installed')}
                        </Badge>
                      ) : cli.missing(id) ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          data-testid={`onb-agent-${id}-install`}
                          disabled={cli.busy(id)}
                          onClick={() => {
                            setCliError('');
                            cli.install(id);
                          }}
                        >
                          {cli.busy(id)
                            ? t('ui.foundation.getting-started-installing')
                            : t('ui.cli-monitor.install-named', cliName(id))}
                        </Button>
                      ) : cli.anyInstalled === null ? (
                        <span className={styles.muted}>
                          {t('ui.mascot-theme.onb-agents-checking')}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {cliError && (
                <p className={styles.error} role="alert">
                  {cliError}
                </p>
              )}
              <p className={styles.note}>{t('ui.mascot-theme.onb-agents-note')}</p>
              {cli.dialog}
            </Group>
            <Group title={t('ui.foundation.model')} desc={t('ui.mascot-theme.onb-model-optional')}>
              {modelOpen || model === 'ready' || model === 'unassigned' ? (
                <div className={styles.revealPanel}>
                  <ProviderSetup onOpenModels={openModels} />
                </div>
              ) : (
                <div className={styles.collapsed} onPointerMove={trackSpotlight}>
                  <span className={styles.collapsedIcon} aria-hidden>
                    <Icon icon={Boxes} size={15} />
                  </span>
                  <span className={styles.collapsedText}>
                    {t('ui.mascot-theme.onb-model-none')}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="onb-model-expand"
                    onClick={() => setModelOpen(true)}
                  >
                    {t('ui.mascot-theme.onb-model-connect')}
                  </Button>
                </div>
              )}
            </Group>
          </>
        );
      case 'personal':
        return (
          <>
            <Group title={t('ui.mascot-theme.name')}>
              <div className={styles.inputWrap} onPointerMove={trackSpotlight}>
                <Input
                  className={styles.input}
                  data-testid="onb-name"
                  aria-label={t('ui.mascot-theme.name')}
                  value={name}
                  maxLength={40}
                  placeholder={t('ui.mascot-theme.e-g-lin-boss-your-name')}
                  onChange={(e) => {
                    touch();
                    setName(e.target.value);
                  }}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && !isImeComposing(e.nativeEvent) && void next()
                  }
                />
                {name.trim() && (
                  <span className={styles.inputGreeting} aria-hidden>
                    <Sparkles size={12} />
                    <span className={styles.inputGreetingText}>
                      {t('ui.mascot-theme.got-it-that-s-what-i-ll-call', name.trim().slice(0, 40))}
                    </span>
                  </span>
                )}
              </div>
            </Group>
            <Group
              title={t('ui.mascot-theme.occupation')}
              desc={role ? ROLE_LABEL[role].hint() : undefined}
              id="onb-role-label"
              className={choiceStyles.group}
            >
              <div
                className={`${styles.options} ${styles.optionsRoles} ${choiceStyles.roles}`}
                role="radiogroup"
                aria-labelledby="onb-role-label"
              >
                {USER_ROLES.map((r, idx) => (
                  <OptionCard
                    key={r}
                    compact
                    hideCheck
                    role="radio"
                    index={idx}
                    on={role === r}
                    testId={`onb-role-${r}`}
                    title={ROLE_LABEL[r].label()}
                    className={choiceStyles.role}
                    iconClassName={choiceStyles.roleIcon}
                    icon={<Icon icon={ROLE_LABEL[r].icon} size={15} />}
                    onClick={() => {
                      touch();
                      setRole(r);
                    }}
                  />
                ))}
              </div>
            </Group>
            <Group
              title={t('ui.mascot-theme.interests-pick-any')}
              desc={t('ui.mascot-theme.i-ll-suggest-coding-agents-example-questions')}
              id="onb-interests-label"
              className={choiceStyles.group}
            >
              <div
                className={`${styles.pills} ${choiceStyles.interests}`}
                role="group"
                aria-labelledby="onb-interests-label"
              >
                {USER_INTERESTS.map((x, idx) => {
                  const on = interests.includes(x);
                  return (
                    <button
                      key={x}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      data-testid={`onb-interest-${x}`}
                      className={`${styles.pill} ${on ? styles.pillOn : ''} ${choiceStyles.interest}`}
                      style={stagger(idx)}
                      onPointerMove={trackSpotlight}
                      onClick={() => {
                        touch();
                        setInterests((cur) =>
                          on
                            ? cur.filter((y) => y !== x)
                            : USER_INTERESTS.filter((y) => y === x || cur.includes(y)),
                        );
                      }}
                    >
                      <span className={styles.pillGlyph} aria-hidden>
                        <Icon icon={INTEREST_ICON[x]} size={13} className={styles.pillIconBase} />
                        <Check size={13} strokeWidth={2.75} className={styles.pillIconCheck} />
                      </span>
                      <span>{INTEREST_LABEL[x]()}</span>
                    </button>
                  );
                })}
              </div>
            </Group>
            <Group title={t('ui.mascot-theme.startup-mode')} id="onb-startup-label">
              <div
                className={`${styles.options} ${styles.optionsPair}`}
                role="radiogroup"
                aria-labelledby="onb-startup-label"
              >
                {STARTUPS.map((x, idx) => (
                  <OptionCard
                    key={x.id}
                    compact
                    hideCheck
                    role="radio"
                    index={idx}
                    on={startup === x.id}
                    testId={`onb-startup-${x.id}`}
                    title={x.label()}
                    hint={x.hint()}
                    icon={
                      <Icon icon={x.id === 'main' ? LayoutPanelLeft : BotMessageSquare} size={16} />
                    }
                    onClick={() => {
                      const prev = startup;
                      setStartup(x.id);
                      void startupClient.set(x.id).then(async (saved) => {
                        const view = saved ?? prev;
                        setStartup(view);
                        if (view === 'main') await startupClient.setShowMascot(false);
                      });
                    }}
                  />
                ))}
              </div>
            </Group>
            <div className={styles.personaEcho} aria-hidden onPointerMove={trackSpotlight}>
              <EndpointIcon backend="nomi" size={18} decorative className={styles.echoLogo} />
              <div className={styles.echoTags}>
                <span className={styles.echoTag}>
                  {startup === 'main'
                    ? t('ui.mascot-theme.onb-startup-workbench')
                    : tName('ui.mascot-theme.onb-startup-character', characterName())}
                </span>
                {name.trim() && (
                  <span className={`${styles.echoTag} ${styles.echoTagAccent}`}>
                    {name.trim().slice(0, 20)}
                  </span>
                )}
                {role && (
                  <span className={`${styles.echoTag} ${styles.echoTagAccent}`}>
                    {ROLE_LABEL[role].label()}
                  </span>
                )}
                {interests.map((x) => (
                  <span key={x} className={styles.echoTag}>
                    {INTEREST_LABEL[x]()}
                  </span>
                ))}
              </div>
            </div>
            <ul className={styles.privacy}>
              <li style={stagger(0)}>
                <Icon icon={Lock} size={12} />
                <span>{t('ui.mascot-theme.chats-memories-and-the-knowledge-base-stay-local')}</span>
              </li>
              <li style={stagger(1)}>
                <Icon icon={KeyRound} size={12} />
                <span>{t('ui.mascot-theme.api-keys-are-encrypted-with-the-system-secure')}</span>
              </li>
              <li style={stagger(2)}>
                <Icon icon={Cloud} size={12} />
                <span>{t('ui.mascot-theme.onb-models-official')}</span>
              </li>
            </ul>
          </>
        );
    }
  })();

  const last = i === STEPS.length - 1;
  const navLast = navI === STEPS.length - 1;
  const pct = ((navI + 1) / STEPS.length) * 100;
  const isMac =
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
  return (
    <div
      className={styles.overlay}
      data-testid="onboarding"
      data-step={step}
      data-brand-intro={introActive(intro.phase) || undefined}
    >
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onb-title"
        onPointerMove={trackCanvasSpotlight}
      >
        <div className={styles.progressTrack} aria-hidden>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
        <header className={styles.topBar}>
          <div className={styles.topLeft}>
            <span className={styles.brand}>
              <BrandLockup ref={introBrandRef} />
            </span>
          </div>
          <nav className={styles.railNav}>
            <ol
              className={styles.stepper}
              aria-label={t('ui.mascot-theme.step-of', navI + 1, STEPS.length)}
            >
              {STEPS.map((s, k) => {
                const done = k < navI;
                const active = k === navI;
                const inner = (
                  <>
                    <span className={styles.stepIndex} aria-hidden>
                      {done ? <Check size={11} strokeWidth={2.75} /> : `0${k + 1}`}
                    </span>
                    <span className={styles.stepName}>{STEP_NAME[s]()}</span>
                  </>
                );
                return (
                  <li
                    key={s}
                    className={`${styles.stepItem} ${active ? styles.stepOn : ''} ${done ? styles.stepDone : ''}`}
                    aria-current={active ? 'step' : undefined}
                  >
                    {done ? (
                      <button
                        type="button"
                        className={styles.stepBtn}
                        disabled={saving}
                        onClick={() => goToStep(k)}
                      >
                        {inner}
                      </button>
                    ) : (
                      <span className={styles.stepBtnStatic}>{inner}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className={styles.topRight}>
            <Button
              variant="ghost"
              size="sm"
              className={styles.skipAllBtn}
              data-testid="onboarding-skip-all"
              onClick={() => void finish(true)}
            >
              {t('ui.mascot-theme.skip-guide')}
            </Button>
          </div>
        </header>
        <div className={styles.scroll} ref={scrollRef}>
          {!introHolding(intro.phase) && (
            <div
              className={styles.step}
              key={step}
              data-dir={dir}
              data-phase={phase}
              data-testid={`onboarding-step-${step}`}
            >
              <div className={styles.hero}>
                <div className={styles.heroBadge} aria-hidden>
                  <span className={styles.heroBadgeDot} />
                  <span>{`0${i + 1} / 0${STEPS.length}`}</span>
                </div>
                <h1 id="onb-title" className={styles.title} tabIndex={-1}>
                  {STEP_TITLE[step]()}
                </h1>
                <p className={styles.intro}>{STEP_INTRO[step]()}</p>
              </div>
              <div className={styles.body}>{body}</div>
            </div>
          )}
        </div>
        <footer className={styles.foot}>
          <div className={styles.footInner}>
            <Button
              variant="ghost"
              size="sm"
              className={styles.backBtn}
              data-testid="onboarding-back"
              data-first={navI === 0 ? 'true' : undefined}
              disabled={navI === 0 || saving}
              onClick={() => goToStep((targetStepRef.current ?? i) - 1)}
            >
              {t('ui.mascot-theme.back')}
            </Button>
            <span className={styles.grow} />
            {!last && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.skipStepBtn}
                data-leaving={navLast ? 'true' : undefined}
                data-testid="onboarding-skip-step"
                disabled={saving}
                onClick={skipStep}
              >
                {t('ui.mascot-theme.skip-this-step')}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              className={styles.primaryCta}
              data-testid={last ? 'onboarding-finish' : 'onboarding-next'}
              disabled={saving}
              onClick={() => void next()}
            >
              <span className={styles.ctaLabel} key={last ? 'finish' : 'next'}>
                {last ? t('ui.mascot-theme.get-started') : t('ui.mascot-theme.next')}
              </span>
              <kbd className={styles.ctaKbd} aria-hidden>
                <span className={styles.ctaKey} data-wide={!isMac ? 'true' : undefined}>
                  {isMac ? '⌘' : 'Ctrl'}
                </span>
                <span className={styles.ctaKey}>↵</span>
              </kbd>
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
};
