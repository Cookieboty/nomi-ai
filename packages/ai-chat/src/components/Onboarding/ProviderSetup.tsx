/**
 * 引导里的「接上模型」：一个连贯的两段式流程，不弹对话框。
 *   1. 选第三方供应商（预设或自定义地址）→ 填 Key / 地址 → 检测并保存（与设置里的模型页同一套存储）；
 *   2. 供应商配好后列出它的对话模型，点一个即设为 Nomi 对话使用的模型。供应商没配好前第 2 段置灰。
 * 下面是「或直接使用本机 CLI」：本机检测到可执行文件的 CLI（ready / no-project）可以直接点选，
 * 记成后续对话的默认托管后端（与主对话底座栏同一个偏好），再选供应商或模型是可选的。
 * 登录不在引导里验证（沿用各 CLI 自己的本机登录）；没有可执行文件的只展示状态、不可选。
 */
import { Icon, t } from '@nomi-ai/ui';
import { IconCircleCheck as CheckCircle2 } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';
import {
  getManagedDefaultRuntime,
  saveManagedDefaultRuntime,
  subscribeManagedDefaultRuntime,
} from '../../services/chatPrefs';
import { gatewayClient, type GatewayState } from '../../services/gatewayClient';
import { nomiMainRef, refreshNomiModel, useGatewayState } from '../../services/nomiModel';
import { backendName } from '../ManagedRuntimeDock/panel';
import { ProviderForm } from '../ModelsPage/ProviderForm';

import styles from './ProviderSetup.module.css';

type LocalCliChoice = {
  id: string;
  available: boolean;
  status: string;
  requiresProject: boolean;
};

/** 本机检测到可执行文件、可作为「只用本机 CLI」进入路径的 CLI（登录仍未验证） */
function cliSelectable(cli: Pick<LocalCliChoice, 'available' | 'status'>): boolean {
  return cli.available || cli.status === 'no-project';
}

/** 已配置、可用于对话的供应商（启用且至少有一个启用的对话模型） */
export function usableProviders(s: GatewayState | null) {
  return (s?.providers ?? []).filter(
    (p) => p.enabled && p.models.some((m) => m.enabled && m.toolCalling !== false),
  );
}

export const ProviderSetup: React.FC<{ onOpenModels: () => void }> = ({ onOpenModels }) => {
  const state = useGatewayState();
  const usable = usableProviders(state);
  const current = state ? nomiMainRef(state) : null;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [localClis, setLocalClis] = useState<LocalCliChoice[]>([]);
  /** 后续对话的默认托管后端（与主对话底座栏同一个偏好） */
  const [defaultBackend, setDefaultBackend] = useState<string | null>(
    () => getManagedDefaultRuntime()?.backend ?? null,
  );

  useEffect(
    () =>
      subscribeManagedDefaultRuntime(() => {
        setDefaultBackend(getManagedDefaultRuntime()?.backend ?? null);
      }),
    [],
  );

  useEffect(() => {
    if (!hasTransport() || typeof api.conversations?.runtimeCapabilities !== 'function') return;
    let canceled = false;
    void api.conversations
      .runtimeCapabilities()
      .then((res) => {
        if (canceled || !res.supported) return;
        setLocalClis(
          res.choices
            .filter((c) => c.requiresProject)
            .map((c) => ({
              id: c.id,
              available: c.available,
              status: c.status,
              requiresProject: c.requiresProject,
            })),
        );
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, []);

  // 第 2 段列哪个供应商：刚配好的 > 当前 Nomi 用的 > 第一个可用的
  const providerId =
    (picked && usable.some((p) => p.id === picked) ? picked : null) ??
    (current ? current.slice(0, current.indexOf('/')) : null) ??
    usable[0]?.id ??
    null;
  const provider = usable.find((p) => p.id === providerId) ?? null;
  const configured = usable.length > 0 && !editing;

  const assign = (ref: string) => {
    setError(null);
    // 已经选了本机 CLI 作为默认底座：再选模型说明要回到模型供应商，偏好一并切回
    if (defaultBackend && defaultBackend !== 'api' && defaultBackend !== 'nomi') {
      saveManagedDefaultRuntime({ backend: 'api' });
      setDefaultBackend('api');
    }
    gatewayClient
      .setAssignment('nomi', { models: { main: ref } })
      .then(refreshNomiModel)
      .catch((e: Error) => setError(e.message));
  };

  const chatModels = provider?.models.filter((m) => m.enabled && m.toolCalling !== false) ?? [];

  /** 只改偏好：引导里不 adopt / switch 任何会话（此时通常也还没有可绑定的会话） */
  const chooseCli = (cli: LocalCliChoice) => {
    if (!cliSelectable(cli)) return;
    setError(null);
    saveManagedDefaultRuntime({ backend: cli.id });
    setDefaultBackend(cli.id);
  };

  return (
    <>
      <section
        className={styles.subStep}
        data-testid="onb-provider-section"
        data-state={configured ? 'configured' : 'form'}
      >
        <div className={styles.subStepHead}>
          <span className={styles.subStepNo}>1</span>
          <span className={styles.subStepTitle}>{t('ui.mascot-theme.onb-choose-provider')}</span>
        </div>
        {configured ? (
          <div className={styles.configured}>
            <Icon icon={CheckCircle2} />
            <span className={styles.grow} data-testid="onb-provider-configured">
              {t('ui.mascot-theme.onb-provider-configured', provider?.name ?? usable[0]!.name)}
            </span>
            <button
              type="button"
              className={styles.link}
              data-testid="onb-provider-change"
              onClick={() => setEditing(true)}
            >
              {t('ui.mascot-theme.onb-use-another-provider')}
            </button>
          </div>
        ) : (
          <ProviderForm
            idPrefix="onb"
            onSaved={(p) => {
              setPicked(p.id);
              setEditing(false);
              refreshNomiModel();
            }}
            onCancel={usable.length > 0 ? () => setEditing(false) : undefined}
          />
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>

      <section
        className={`${styles.subStep} ${provider ? '' : styles.subStepOff}`}
        data-testid="onb-model-section"
        aria-disabled={!provider}
        data-state={!provider ? 'disabled' : current ? 'ready' : 'choose'}
      >
        <div className={styles.subStepHead}>
          <span className={styles.subStepNo}>2</span>
          <span className={styles.subStepTitle}>{t('ui.mascot-theme.onb-choose-model')}</span>
        </div>
        {!provider ? (
          <p className={styles.note}>{t('ui.mascot-theme.onb-provider-first')}</p>
        ) : (
          <div className={styles.chips} role="radiogroup">
            {chatModels.map((m) => {
              const ref = `${provider.id}/${m.id}`;
              return (
                <button
                  key={ref}
                  type="button"
                  role="radio"
                  aria-checked={current === ref}
                  className={`${styles.chip} ${current === ref ? styles.chipOn : ''}`}
                  data-testid={`onb-model-${m.id}`}
                  onClick={() => assign(ref)}
                >
                  {current === ref && <Icon icon={CheckCircle2} size={14} />}
                  <span>{m.label ?? m.id}</span>
                </button>
              );
            })}
          </div>
        )}
        {current && provider && (
          <p className={styles.note} data-testid="onb-model-ready">
            {t('ui.mascot-theme.onb-model-ready')}
          </p>
        )}
      </section>

      <p className={styles.note}>
        <button
          type="button"
          className={styles.link}
          data-testid="onb-open-models"
          onClick={onOpenModels}
        >
          {t('ui.mascot-theme.open-full-model-settings')}
        </button>{' '}
        {t('ui.mascot-theme.open-full-model-settings-hint')}
      </p>

      {localClis.length > 0 && (
        <section className={styles.subStep} data-testid="onb-cli-first-use">
          <div className={styles.subStepHead}>
            <span className={styles.subStepTitle}>{t('ui.chat-settings.onb-cli-card-title')}</span>
          </div>
          <p className={styles.note}>{t('ui.chat-settings.onb-cli-card-desc')}</p>
          <div
            className={styles.chips}
            role="radiogroup"
            aria-label={t('ui.chat-settings.onb-cli-card-title')}
          >
            {localClis.map((cli) => {
              const label = backendName(cli.id);
              const selectable = cliSelectable(cli);
              const status = `${label}: ${
                selectable
                  ? t('ui.chat-settings.onb-cli-status-ready')
                  : t('ui.chat-settings.onb-cli-status-missing')
              }`;
              if (!selectable) {
                return (
                  <span
                    key={cli.id}
                    className={styles.chip}
                    data-testid={`onb-cli-${cli.id}`}
                    data-selectable="false"
                    aria-label={status}
                  >
                    {status}
                  </span>
                );
              }
              const on = defaultBackend === cli.id;
              return (
                <button
                  key={cli.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`${styles.chip} ${on ? styles.chipOn : ''}`}
                  data-testid={`onb-cli-${cli.id}`}
                  data-selectable="true"
                  onClick={() => chooseCli(cli)}
                >
                  {on && <Icon icon={CheckCircle2} size={14} />}
                  <span>{status}</span>
                </button>
              );
            })}
          </div>
          {localClis.some(cliSelectable) && (
            <p className={styles.note}>{t('ui.chat-settings.onb-cli-select-hint')}</p>
          )}
          {localClis.some((c) => cliSelectable(c) && c.id === defaultBackend) && (
            <p className={styles.note} data-testid="onb-cli-default-on">
              {t('ui.chat-settings.onb-cli-default-on')}
            </p>
          )}
        </section>
      )}
    </>
  );
};
