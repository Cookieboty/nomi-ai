/**
 * 侧栏「开始使用」清单：刚装好、还没配模型 / 没装编程助手 / 还没开始对话时，告诉新用户下一步做什么。
 * - 每一步按真实状态打勾：模型看第三方供应商的生效状态，编程助手看本机安装检测，对话看侧栏列表；
 * - 模型与编程助手有一个就能用（助手模式先模型，工作台模式先编程助手，另一项标「可选」）；
 * - 能用之后再列几个值得知道的功能；有了第一个对话或用户点「×」后不再出现（只记在本机）。
 */
import { Button, Icon, IconButton, t } from '@nomi-ai/ui';
import { CircleCheck, Circle, X } from 'lucide-react';
import React, { useState } from 'react';

import { useNomiModelStatus } from '../../hooks/useNomiModelStatus';
import { cliUpdateClient } from '../../services/cliUpdateClient';
import { useCliInstall } from '../ModelsPage/useCliInstall';
import type { SettingsSection, SettingsTab } from '../SettingsView/sections';

import styles from './index.module.css';

const DISMISS_KEY = 'nomi.gettingStarted.dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}
function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* 隐私窗口等：只在本次会话里隐藏 */
  }
}

interface Props {
  /** 助手（Nomi 对话）或工作台（编程助手） */
  mode: 'assistant' | 'workbench';
  /** 侧栏里已经有对话 */
  hasChats: boolean;
  onOpenSettings: (section: SettingsSection, tab?: SettingsTab) => void;
  /** 「开始」：助手模式新对话并聚焦输入框，工作台模式打开新会话菜单 */
  onStart: () => void;
}

interface Step {
  id: 'model' | 'cli' | 'start';
  done: boolean;
  title: string;
  desc: string;
  optional?: boolean;
  action?: React.ReactNode;
}

export const GettingStarted: React.FC<Props> = ({ mode, hasChats, onOpenSettings, onStart }) => {
  const [dismissed, setDismissed] = useState(readDismissed);
  const modelStatus = useNomiModelStatus();
  const [err, setErr] = useState('');
  const cli = useCliInstall(setErr);

  // 桌面桥不在（浏览器 / 单测）或还没查到状态：不显示，避免闪一下
  const checking =
    modelStatus === null || (cliUpdateClient.available() && cli.anyInstalled === null);
  if (dismissed || checking) return null;
  if (modelStatus === undefined && !cliUpdateClient.available()) return null;

  const model = modelStatus === 'ready';
  const coding = !!cli.anyInstalled;
  const ready = model || coding;
  if (ready && hasChats) return null;

  const installBtn = (kind: 'claude' | 'codex', name: string) =>
    cli.missing(kind) && (
      <Button
        key={kind}
        size="sm"
        variant={mode === 'workbench' ? 'primary' : 'secondary'}
        disabled={!!cli.busy}
        onClick={() => cli.install(kind)}
        data-testid={`getting-started-install-${kind}`}
      >
        {cli.busy === kind
          ? t('ui.foundation.getting-started-installing')
          : t('ui.cli-monitor.install-named', name)}
      </Button>
    );

  const modelStep: Step = {
    id: 'model',
    done: model,
    title: t('ui.foundation.getting-started-add-a-model'),
    desc:
      modelStatus === 'unassigned'
        ? t('ui.foundation.pick-one-of-your-models-for-nomi-chat')
        : t('ui.foundation.getting-started-add-a-model-desc'),
    optional: mode === 'workbench',
    action: (
      <Button
        size="sm"
        variant={mode === 'assistant' ? 'primary' : 'secondary'}
        onClick={() => onOpenSettings('models')}
        data-testid="getting-started-add-model"
      >
        {modelStatus === 'unassigned'
          ? t('ui.models.choose-a-model')
          : t('ui.foundation.getting-started-go-add')}
      </Button>
    ),
  };
  const cliStep: Step = {
    id: 'cli',
    done: coding,
    title: t('ui.foundation.getting-started-install-a-coding-agent'),
    desc: t('ui.foundation.getting-started-install-a-coding-agent-desc'),
    optional: mode === 'assistant',
    action: (
      <>
        {installBtn('claude', 'Claude Code')}
        {installBtn('codex', 'Codex')}
      </>
    ),
  };
  const startStep: Step = {
    id: 'start',
    done: hasChats,
    title:
      mode === 'workbench'
        ? t('ui.foundation.getting-started-open-a-coding-session')
        : t('ui.foundation.getting-started-start-your-first-chat'),
    desc:
      mode === 'workbench'
        ? t('ui.foundation.getting-started-open-a-coding-session-desc')
        : t('ui.foundation.getting-started-start-your-first-chat-desc'),
    action: (
      <Button
        size="sm"
        disabled={!ready}
        onClick={() => {
          onStart();
          // 助手模式：新对话后把焦点放进输入框
          if (mode === 'assistant')
            requestAnimationFrame(() =>
              document.querySelector<HTMLTextAreaElement>('textarea')?.focus(),
            );
        }}
        data-testid="getting-started-start"
      >
        {t('ui.model-quality.start')}
      </Button>
    ),
  };
  const steps =
    mode === 'workbench' ? [cliStep, modelStep, startStep] : [modelStep, cliStep, startStep];

  const tips: Array<{ id: string; label: string; hint?: string; run?: () => void }> = [
    {
      id: 'kb',
      label: t('ui.foundation.getting-started-add-a-knowledge-folder'),
      run: () => onOpenSettings('knowledge', 'kb'),
    },
    {
      id: 'ext',
      label: t('ui.foundation.getting-started-import-mcp-and-skills'),
      run: () => onOpenSettings('ext'),
    },
  ];

  return (
    <section
      className={styles.card}
      aria-label={t('ui.mascot-theme.get-started')}
      data-testid="getting-started"
      data-mode={mode}
    >
      <div className={styles.head}>
        <span className={styles.title}>{t('ui.mascot-theme.get-started')}</span>
        <IconButton
          size="sm"
          label={t('ui.chat-settings.hide')}
          icon={<Icon icon={X} size={14} />}
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
          data-testid="getting-started-dismiss"
        />
      </div>
      <ol className={styles.steps}>
        {steps.map((s) => (
          <li
            key={s.id}
            className={styles.step}
            data-done={s.done ? 'true' : undefined}
            data-testid={`getting-started-step-${s.id}`}
          >
            <span className={styles.mark} aria-hidden="true">
              <Icon icon={s.done ? CircleCheck : Circle} size={16} />
            </span>
            <div className={styles.body}>
              <span className={styles.stepTitle}>
                {s.title}
                {s.optional && !s.done && (
                  <span className={styles.optional}>
                    {t('ui.foundation.getting-started-optional')}
                  </span>
                )}
                <span className={styles.srOnly}>
                  {s.done ? t('ui.foundation.done') : t('ui.foundation.getting-started-to-do')}
                </span>
              </span>
              {!s.done && (
                <>
                  <span className={styles.desc}>{s.desc}</span>
                  {s.action && <div className={styles.actions}>{s.action}</div>}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {err && (
        <p className={styles.err} role="alert">
          {err}
        </p>
      )}
      {cli.dialog}
      {ready && (
        <div className={styles.tips} data-testid="getting-started-tips">
          <span className={styles.tipsTitle}>{t('ui.foundation.getting-started-also-try')}</span>
          <ul className={styles.tipList}>
            {tips.map((x) =>
              x.run ? (
                <li key={x.id}>
                  <button type="button" className={styles.tip} onClick={x.run}>
                    {x.label}
                  </button>
                </li>
              ) : (
                <li key={x.id} className={styles.tipStatic}>
                  {x.label}
                  {x.hint && <kbd className={styles.kbd}>{x.hint}</kbd>}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </section>
  );
};
