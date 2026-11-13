/**
 * 首次启动引导，三步：
 *   1. 语言和外观；
 *   2. AI 能力：编程助手（检测本机、没装的就地安装，用自己的账号登录）+ 对话模型（第三方供应商，可选）；
 *   3. 个性化：称呼、职业与兴趣、启动方式（都可选）。
 * 职业与兴趣存在主进程，侧栏「开始使用」与欢迎页据此推荐任务（services/recommendations）。
 * 填过的称呼、职业与兴趣在结束时一起保存（「跳过引导」也保存；没改过就不写）。
 * 结束后装了编程助手的进看板，一个都没装的留在对话。右上角「跳过引导」直接结束；
 * 完成后可在「设置 → 通用」重新打开。引导盖住整个窗口；桌面角色只有被打开时才说话。
 */
import { cliName } from '@nomi-ai/cli-catalog';
import {
  USER_INTERESTS,
  USER_ROLES,
  type UserInterest,
  type UserProfile,
  type UserRole,
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
import { Check, CheckCircle2, Cloud, KeyRound, Lock } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useNomiModelStatus } from '../../hooks/useNomiModelStatus';
import { characterName, useCharacterName } from '../../services/characterName';
import { startupClient, type StartupView } from '../../services/startupClient';
import { requestOpenFleet } from '../../services/workbenchNav';
import { isImeComposing } from '../../utils/keyboard';
import { DISPATCH_CLIS } from '../DispatchCli';
import { EndpointIcon } from '../EndpointIcon';
import { useCliInstall } from '../ModelsPage/useCliInstall';
import { ChatBackgroundSettings } from '../SettingsView/ChatBackgroundSettings';

import {
  OPEN_MODELS_EVENT,
  matchTemplate,
  mergePersona,
  onboardingClient,
  personaBlockLines,
} from './client';
import styles from './index.module.css';
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
  children: React.ReactNode;
}> = ({ title, desc, id, children }) => (
  <section className={styles.group} aria-labelledby={id}>
    <div className={styles.groupHead}>
      <h2 className={styles.groupTitle} id={id}>
        {title}
      </h2>
      {desc && <p className={styles.groupDesc}>{desc}</p>}
    </div>
    {children}
  </section>
);

/** 可选中的卡片（主题、职业、启动方式）：选中只换描边并在右上角打勾，不整块填色 */
const OptionCard: React.FC<{
  on: boolean;
  role: 'radio' | 'checkbox';
  testId: string;
  title: string;
  hint?: string;
  preview?: React.ReactNode;
  onClick: () => void;
}> = ({ on, role, testId, title, hint, preview, onClick }) => (
  <button
    type="button"
    role={role}
    aria-checked={on}
    data-testid={testId}
    className={`${styles.option} ${on ? styles.optionOn : ''}`}
    onClick={onClick}
  >
    {preview}
    <span className={styles.optionTitle}>{title}</span>
    {hint && <span className={styles.optionHint}>{hint}</span>}
    <span className={styles.optionCheck} aria-hidden>
      <Check size={12} strokeWidth={3} />
    </span>
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
  /** 对话模型那一组默认收起（供应商列表很长，会把编程助手挤出首屏）；已经接好模型的直接展开 */
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
      // 装了编程助手：进看板（空看板上就是派出按钮）；一个都没装：留在对话，「开始使用」清单接着引导
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

  // 保存（写 persona / 职业与兴趣）期间不能再前进 / 后退 / 跳过，否则会连跳两步或丢掉正在写的内容
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const next = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (i === STEPS.length - 1) return await finish(false);
      setI(i + 1);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const skipStep = () => {
    if (savingRef.current) return;
    setI(Math.min(i + 1, STEPS.length - 1));
  };
  const touch = () => {
    profileTouched.current = true;
  };

  const body = (() => {
    switch (step) {
      case 'welcome': {
        // 浅色（新安装默认）排在前面，不把日落橙标成另一套默认
        const themes = [
          ...THEMES.filter((x) => x.id === 'light' || x.id === 'dark' || x.id === 'sunset'),
          ...THEMES.filter((x) => x.id !== 'light' && x.id !== 'dark' && x.id !== 'sunset'),
        ];
        return (
          <>
            <Group title={t('ui.mascot-theme.choose-your-language')}>
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
                {themes.map((x) => (
                  <OptionCard
                    key={x.id}
                    role="radio"
                    on={theme === x.id}
                    testId={`onb-theme-${x.id}`}
                    title={t(x.name)}
                    preview={
                      <span
                        className={styles.swatch}
                        aria-hidden
                        style={{
                          background:
                            x.id === 'system'
                              ? `linear-gradient(110deg, ${x.swatch[0]} 50%, ${x.swatch[2]} 50%)`
                              : `linear-gradient(135deg, ${x.swatch[0]} 62%, ${x.swatch[3]} 62%)`,
                        }}
                      />
                    }
                    onClick={() => {
                      setThemeSel(x.id);
                      void setTheme(x.id);
                    }}
                  />
                ))}
              </div>
              {theme === 'image' && <ChatBackgroundSettings />}
            </Group>
          </>
        );
      }
      case 'ai':
        return (
          <>
            <Group
              title={t('ui.providers-schedule.coding-agents')}
              desc={t('ui.mascot-theme.onb-agents-group-desc')}
            >
              <ul className={styles.list}>
                {DISPATCH_CLIS.map((id) => {
                  const installed = cli.installed(id);
                  return (
                    <li key={id} className={styles.listRow} data-testid={`onb-agent-${id}`}>
                      <span className={styles.listIcon}>
                        <EndpointIcon backend={id} size={20} decorative />
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
            <Group
              title={t('ui.mascot-theme.onb-section-model')}
              desc={t('ui.mascot-theme.onb-model-optional')}
            >
              {modelOpen || model === 'ready' || model === 'unassigned' ? (
                <ProviderSetup onOpenModels={openModels} />
              ) : (
                <div className={styles.collapsed}>
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
            </Group>
            <Group title={t('ui.mascot-theme.occupation')} id="onb-role-label">
              <div
                className={`${styles.options} ${styles.optionsRoles}`}
                role="radiogroup"
                aria-labelledby="onb-role-label"
              >
                {USER_ROLES.map((r) => (
                  <OptionCard
                    key={r}
                    role="radio"
                    on={role === r}
                    testId={`onb-role-${r}`}
                    title={ROLE_LABEL[r].label()}
                    hint={ROLE_LABEL[r].hint()}
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
            >
              <div className={styles.pills} role="group" aria-labelledby="onb-interests-label">
                {USER_INTERESTS.map((x) => {
                  const on = interests.includes(x);
                  return (
                    <button
                      key={x}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      data-testid={`onb-interest-${x}`}
                      className={`${styles.pill} ${on ? styles.pillOn : ''}`}
                      onClick={() => {
                        touch();
                        setInterests((cur) =>
                          on
                            ? cur.filter((y) => y !== x)
                            : USER_INTERESTS.filter((y) => y === x || cur.includes(y)),
                        );
                      }}
                    >
                      {on && <Check size={14} strokeWidth={2.5} aria-hidden />}
                      {INTEREST_LABEL[x]()}
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
                {STARTUPS.map((x) => (
                  <OptionCard
                    key={x.id}
                    role="radio"
                    on={startup === x.id}
                    testId={`onb-startup-${x.id}`}
                    title={x.label()}
                    hint={x.hint()}
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
            <ul className={styles.privacy}>
              <li>
                <Icon icon={Lock} size={14} />
                {t('ui.mascot-theme.chats-memories-and-the-knowledge-base-stay-local')}
              </li>
              <li>
                <Icon icon={KeyRound} size={14} />
                {t('ui.mascot-theme.api-keys-are-encrypted-with-the-system-secure')}
              </li>
              <li>
                <Icon icon={Cloud} size={14} />
                {t('ui.mascot-theme.onb-models-official')}
              </li>
            </ul>
          </>
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
          <ol
            className={styles.stepper}
            aria-label={t('ui.mascot-theme.step-of', i + 1, STEPS.length)}
          >
            {STEPS.map((s, k) => (
              <li
                key={s}
                className={`${styles.stepItem} ${k === i ? styles.stepOn : ''} ${k < i ? styles.stepDone : ''}`}
                aria-current={k === i ? 'step' : undefined}
              >
                <span className={styles.stepNo} aria-hidden>
                  {k < i ? <Check size={12} strokeWidth={3} /> : k + 1}
                </span>
                <span className={styles.stepName}>{STEP_NAME[s]()}</span>
              </li>
            ))}
          </ol>
          <Button
            variant="ghost"
            size="sm"
            data-testid="onboarding-skip-all"
            onClick={() => void finish(true)}
          >
            {t('ui.mascot-theme.skip-guide')}
          </Button>
        </header>
        <div className={styles.scroll}>
          <div className={styles.step} key={step} data-testid={`onboarding-step-${step}`}>
            <h1 id="onb-title" className={styles.title}>
              {STEP_TITLE[step]()}
            </h1>
            <p className={styles.intro}>{STEP_INTRO[step]()}</p>
            <div className={styles.body}>{body}</div>
          </div>
        </div>
        <footer className={styles.foot}>
          <div className={styles.footInner}>
            <Button
              variant="ghost"
              data-testid="onboarding-back"
              disabled={i === 0 || saving}
              onClick={() => setI(Math.max(0, i - 1))}
            >
              {t('ui.mascot-theme.back')}
            </Button>
            <span className={styles.grow} />
            {!last && (
              <Button
                variant="ghost"
                data-testid="onboarding-skip-step"
                disabled={saving}
                onClick={skipStep}
              >
                {t('ui.mascot-theme.skip-this-step')}
              </Button>
            )}
            <Button
              variant="primary"
              data-testid={last ? 'onboarding-finish' : 'onboarding-next'}
              disabled={saving}
              onClick={() => void next()}
            >
              {last ? t('ui.mascot-theme.get-started') : t('ui.mascot-theme.next')}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
};
