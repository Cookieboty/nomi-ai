/**
 * 持续任务表单里 CLI 执行方式的解析与提交载荷构建（从 TaskForm.tsx 拆分保持组件精简）。
 */
import type {
  DelegateCli,
  DelegateSettingsView,
  RunnerPreset,
  RunnerSource,
  RunnerEffort,
} from '../../services/delegateClient';
import type { GatewayState } from '../../services/gatewayClient';
import { thirdPartyOnly } from '../../utils/cliCaps';
import type { RunnerSpecValue } from '../RunnerModelPicker';

export interface ScheduledCustomTarget {
  cli: DelegateCli;
  source: RunnerSource;
  accountId?: string | null;
  model?: string | null;
  reasoningEffort?: RunnerEffort | null;
}

export interface TaskCliSelection {
  presets: RunnerPreset[];
  hasPresets: boolean;
  scheduledPreset: RunnerPreset | null;
  scheduledCustom: ScheduledCustomTarget | null;
  scheduledCli: string;
  effectiveCliMode: string;
  activePreset: RunnerPreset | null;
  resolvedCli: string;
  initialCustomSpec: RunnerSpecValue;
}

export function resolveTaskCliSelection(params: {
  delegateState: DelegateSettingsView | null;
  cliMode: string;
  cli: string;
  installed: readonly string[];
  defaultClis: readonly string[];
  bins: Record<string, string | null | undefined>;
  customSpec: RunnerSpecValue | null;
  gateway: GatewayState | null;
}): TaskCliSelection {
  const { delegateState, cliMode, cli, installed, defaultClis, bins, customSpec, gateway } = params;
  const presets = delegateState?.presets ?? [];
  const hasPresets = presets.length > 0;

  const rt = delegateState?.routes?.scheduled;
  const scheduledPreset =
    rt?.kind === 'preset'
      ? (presets.find((p) => p.id === rt.presetId) ?? presets[0] ?? null)
      : rt?.kind === 'custom'
        ? null
        : (presets.find((p) => p.id === 'low' || p.costTier === 'low') ?? presets[0] ?? null);

  const scheduledCustom =
    rt?.kind === 'custom'
      ? {
          cli: rt.cli,
          source: rt.source,
          accountId: rt.accountId,
          model: rt.model,
          reasoningEffort: rt.reasoningEffort,
        }
      : null;

  const scheduledCli = scheduledCustom?.cli ?? scheduledPreset?.cli ?? '';
  const effectiveCliMode =
    cliMode === 'auto'
      ? hasPresets && scheduledCli && bins[scheduledCli]
        ? 'scheduled'
        : 'cli'
      : cliMode;

  const activePreset = effectiveCliMode.startsWith('preset:')
    ? (presets.find((p) => p.id === effectiveCliMode.slice('preset:'.length)) ?? null)
    : effectiveCliMode === 'scheduled'
      ? scheduledPreset
      : null;

  const resolvedCli =
    effectiveCliMode === 'custom'
      ? (customSpec?.cli ?? '')
      : effectiveCliMode === 'cli'
        ? cli
        : (activePreset?.cli ?? scheduledCustom?.cli ?? cli);

  const baseCli = ((resolvedCli || installed[0] || defaultClis[0]) ?? 'claude') as DelegateCli;
  const firstTpModel =
    gateway?.clients?.[baseCli]?.models?.main ??
    (gateway?.providers?.[0]?.models?.[0]
      ? `${gateway.providers[0].id}/${gateway.providers[0].models[0].id}`
      : null);
  let initialCustomSpec: RunnerSpecValue;
  if (thirdPartyOnly(baseCli)) {
    initialCustomSpec = {
      cli: baseCli,
      source: 'thirdParty',
      model: firstTpModel,
      reasoningEffort: null,
    };
  } else if (delegateState?.localAvailable?.[baseCli]) {
    initialCustomSpec = {
      cli: baseCli,
      source: 'local',
      accountId: null,
      model: null,
      reasoningEffort: null,
    };
  } else if (firstTpModel) {
    initialCustomSpec = {
      cli: baseCli,
      source: 'thirdParty',
      accountId: null,
      model: firstTpModel,
      reasoningEffort: null,
    };
  } else {
    initialCustomSpec = {
      cli: baseCli,
      source: 'official',
      accountId: null,
      model: null,
      reasoningEffort: null,
    };
  }

  return {
    presets,
    hasPresets,
    scheduledPreset,
    scheduledCustom,
    scheduledCli,
    effectiveCliMode,
    activePreset,
    resolvedCli,
    initialCustomSpec,
  };
}

export function buildTaskCliExecutor(
  selection: TaskCliSelection,
  customSpec: RunnerSpecValue | null,
  cwd: string,
) {
  const { effectiveCliMode, activePreset, scheduledPreset, scheduledCustom, resolvedCli } =
    selection;
  if (effectiveCliMode === 'custom' && customSpec) {
    return {
      kind: 'cli' as const,
      cli: customSpec.cli,
      cwd,
      isolation: 'worktree' as const,
      source: customSpec.source,
      ...(customSpec.accountId ? { accountId: customSpec.accountId } : {}),
      ...(customSpec.model ? { model: customSpec.model } : {}),
      ...(customSpec.reasoningEffort ? { reasoningEffort: customSpec.reasoningEffort } : {}),
    };
  }
  if (effectiveCliMode.startsWith('preset:') && activePreset) {
    // 档位模式只存 presetId：执行参数以触发时的当前档位为准，不把旧的 cli / 来源 / 账号 / 模型一起落盘
    return { kind: 'cli' as const, cwd, isolation: 'worktree' as const, presetId: activePreset.id };
  }
  if (effectiveCliMode === 'scheduled') {
    if (scheduledPreset) {
      return {
        kind: 'cli' as const,
        cwd,
        isolation: 'worktree' as const,
        presetId: scheduledPreset.id,
      };
    }
    if (scheduledCustom) {
      return {
        kind: 'cli' as const,
        cli: scheduledCustom.cli,
        cwd,
        isolation: 'worktree' as const,
        source: scheduledCustom.source,
        ...(scheduledCustom.accountId ? { accountId: scheduledCustom.accountId } : {}),
        ...(scheduledCustom.model ? { model: scheduledCustom.model } : {}),
        ...(scheduledCustom.reasoningEffort
          ? { reasoningEffort: scheduledCustom.reasoningEffort }
          : {}),
      };
    }
  }
  return { kind: 'cli' as const, cli: resolvedCli, cwd, isolation: 'worktree' as const };
}
