/**
 * CLI 后端（Claude Code / Codex / dsh）输入栏上的供应商 / 模型芯片。
 *
 * 只读取该后端自己的档案库（cli-providers/<kind>/store.json），绝不显示 Nomi 的供应商；
 * 没有启用的档案时显示「CLI 默认 / 已登录」。快速切换只在本后端的档案里选。
 */
import { Select, t, Icon } from '@nomi-ai/ui';
import { KeyRound } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import {
  cliProviderClient,
  type CliProviderKind,
  type CliProviderProfile,
  type CliProviderState,
} from '../../services/cliProviderClient';

export const CLI_DEFAULT_VALUE = '';

/** 该后端当前启用的档案（没有则为 null = CLI 自带登录/默认配置） */
export function activeProfileOf(
  state: CliProviderState | null,
  kind: CliProviderKind,
): CliProviderProfile | null {
  return state?.profiles.find((p) => p.kind === kind && p.active) ?? null;
}

const SWITCHER_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--cd-space-1)',
};

export const CliProviderChip: React.FC<{
  backend: CliProviderKind;
  className?: string;
  onManage?: () => void;
}> = ({ backend, className, onManage }) => {
  const [state, setState] = useState<CliProviderState | null>(null);
  const [err, setErr] = useState('');
  const available = cliProviderClient.available();

  useEffect(() => {
    if (!available) return;
    let alive = true;
    void cliProviderClient
      .state()
      .then((s) => alive && setState(s))
      .catch(() => alive && setState(null));
    const off = cliProviderClient.onChanged((s) => alive && setState(s));
    return () => {
      alive = false;
      off();
    };
  }, [available]);

  if (!available) return null;
  const profiles = (state?.profiles ?? []).filter((p) => p.kind === backend);
  const active = activeProfileOf(state, backend);

  const pick = async (id: string) => {
    setErr('');
    try {
      if (id === CLI_DEFAULT_VALUE) {
        const r = await cliProviderClient.deactivate(backend);
        if (!r.ok) setErr(r.error || t('停用失败'));
      } else {
        const r = await cliProviderClient.activate(id);
        if (!r.ok) setErr(r.error || t('启用失败'));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <span
      className={className}
      data-testid="cli-provider-chip"
      data-backend={backend}
      data-source={active ? 'own-store' : 'cli-default'}
      style={SWITCHER_STYLE}
    >
      <Select
        size="sm"
        style={{ width: 'auto', maxWidth: 260 }}
        data-testid="cli-provider-switch"
        aria-label={t('{0} 供应商', backendName(backend))}
        title={
          err ||
          (active
            ? t('{0} 的供应商档案（独立于 Nomi）', backendName(backend))
            : t('未启用档案：沿用 {0} 自带的登录与默认配置', backendName(backend)))
        }
        value={active?.id ?? CLI_DEFAULT_VALUE}
        onChange={(e) => void pick(e.target.value)}
        menuMinWidth={260}
        options={[
          {
            value: CLI_DEFAULT_VALUE,
            label: t('CLI 默认 / 已登录'),
            description: t('沿用 CLI 自带登录与默认配置'),
          },
          ...profiles.map((p) => ({
            value: p.id,
            label: p.name,
            description: p.model || undefined,
          })),
        ]}
      />
      {active?.model && (
        <span
          data-testid="cli-model-label"
          style={{ fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap' }}
          title={t('模型')}
        >
          {active.model}
        </span>
      )}
      {err && (
        <span
          role="alert"
          data-testid="cli-provider-err"
          style={{ fontSize: 11, color: '#e5534b' }}
        >
          {err}
        </span>
      )}
      {onManage && (
        <button
          type="button"
          className="cd-btn cd-btn-ghost"
          data-testid="open-cli-provider-panel"
          style={{ fontSize: 12 }}
          onClick={onManage}
          title={t('打开 {0} 的供应商设置', backendName(backend))}
          aria-label={t('打开 {0} 的供应商设置', backendName(backend))}
        >
          <Icon icon={KeyRound} size={14} />
        </button>
      )}
    </span>
  );
};

function backendName(b: CliProviderKind): string {
  return b === 'claude'
    ? t('Claude Code')
    : b === 'codex'
      ? t('Codex')
      : b === 'grok'
        ? 'Grok'
        : 'dsh';
}
