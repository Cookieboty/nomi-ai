/**
 * 任务模型的显示与切换控件（Nomi 任务 + CLI 任务）：
 * - Nomi 任务：复用 NomiModelSwitch 的 binding，读写 tasks.update({ model, reasoningEffort })；
 * - CLI 任务且有存活后台标签：直接复用 ModelControls 并把变更同步回 tasks.update；
 * - CLI 任务且无存活标签：展示胶囊按钮，点击弹出锁定当前 CLI 的 RunnerModelPicker，确认后写入 tasks.update。
 */
import { Icon, t } from '@nomi-ai/ui';
import { IconChevronDown as ChevronDown } from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { refSlashLabel } from '../../services/cliSource';
import {
  delegateClient,
  presetDisplayLabel,
  type DelegateCli,
  type DelegateSettingsView,
  type RunnerEffort,
  type RunnerSource,
} from '../../services/delegateClient';
import type { HarnessTabMeta } from '../../services/harnessClient';
import { useGatewayState } from '../../services/nomiModel';
import { tasksApi, type Task } from '../../services/tasksClient';
import { localOnly, thirdPartyOnly } from '../../utils/cliCaps';
import { EndpointIcon } from '../EndpointIcon';
import { ModelControls } from '../ModelControls';
import { thinkingLevelLabel } from '../ModelControls/effortLabel';
import { NomiModelSwitch, type NomiModelBinding } from '../NomiModelSwitch';
import { RunnerModelPicker, type RunnerSpecValue } from '../RunnerModelPicker';

import styles from './TaskModelSwitch.module.css';

export interface TaskModelSwitchProps {
  task: Task;
  liveTab?: HarnessTabMeta | null;
  placement?: 'composer' | 'settings' | 'subagent';
  onOpenProviders?: () => void;
}

export const TaskModelSwitch: React.FC<TaskModelSwitchProps> = ({
  task,
  liveTab = null,
  placement = 'composer',
  onOpenProviders,
}) => {
  const gateway = useGatewayState();
  const executor = task.executor;
  const nomiExec = executor?.kind === 'nomi' ? executor : null;
  const cliExec = executor?.kind === 'cli' ? executor : null;
  const isNomi = nomiExec !== null;
  const isCli = cliExec !== null;

  const [nomiOpt, setNomiOpt] = useState<{
    taskId: string;
    baseUpdatedAt: number;
    model?: string | null;
    effort?: string | null;
  } | null>(null);

  const [cliOpt, setCliOpt] = useState<{
    taskId: string;
    baseUpdatedAt: number;
    spec: RunnerSpecValue;
  } | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [delegateState, setDelegateState] = useState<DelegateSettingsView | null>(null);

  useEffect(() => {
    if (!isCli || liveTab || !delegateClient.available()) return;
    let alive = true;
    void delegateClient
      .settings()
      .then((v) => {
        if (alive) setDelegateState(v);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [isCli, liveTab, pickerOpen]);

  const activeNomiOpt =
    nomiOpt && nomiOpt.taskId === task.id && nomiOpt.baseUpdatedAt === task.updatedAt
      ? nomiOpt
      : null;

  const nomiModel = nomiExec
    ? activeNomiOpt && activeNomiOpt.model !== undefined
      ? activeNomiOpt.model
      : (nomiExec.model ?? null)
    : null;
  const nomiEffort = nomiExec
    ? activeNomiOpt && activeNomiOpt.effort !== undefined
      ? (activeNomiOpt.effort ?? undefined)
      : nomiExec.reasoningEffort
    : undefined;

  const nomiBinding = useMemo<NomiModelBinding | null>(() => {
    if (!isNomi) return null;
    const prefix = placement === 'settings' ? 'task-settings-nomi' : 'task-nomi';
    return {
      model: nomiModel,
      effort: nomiEffort,
      menuKey: `task-nomi:${task.id}:${placement}`,
      testPrefix: prefix,
      onModel: (ref) => {
        setNomiOpt((prev) => ({
          taskId: task.id,
          baseUpdatedAt: task.updatedAt,
          ...(prev && prev.taskId === task.id && prev.baseUpdatedAt === task.updatedAt
            ? { effort: prev.effort }
            : {}),
          model: ref,
        }));
        void tasksApi.update({ id: task.id, model: ref }).catch(() => setNomiOpt(null));
      },
      onEffort: (level) => {
        setNomiOpt((prev) => ({
          taskId: task.id,
          baseUpdatedAt: task.updatedAt,
          ...(prev && prev.taskId === task.id && prev.baseUpdatedAt === task.updatedAt
            ? { model: prev.model }
            : {}),
          effort: level ?? null,
        }));
        void tasksApi
          .update({ id: task.id, reasoningEffort: level ?? null })
          .catch(() => setNomiOpt(null));
      },
    };
  }, [isNomi, nomiModel, nomiEffort, task.id, task.updatedAt, placement]);

  const handleTabUpdated = useCallback(
    (updated: HarnessTabMeta) => {
      if (!task.executor || task.executor.kind !== 'cli') return;
      const ex = task.executor;
      const sourceChanged = (updated.source ?? null) !== (ex.source ?? null);
      const accountChanged = (updated.accountId ?? null) !== (ex.accountId ?? null);
      const clearPreset = Boolean(ex.presetId) && (sourceChanged || accountChanged);
      void tasksApi
        .update({
          id: task.id,
          source: updated.source ?? null,
          accountId: updated.source === 'official' ? (updated.accountId ?? null) : null,
          model: updated.modelOverride ?? null,
          reasoningEffort: updated.reasoningEffort ?? null,
          ...(clearPreset ? { presetId: null } : {}),
        })
        .catch(() => undefined);
    },
    [task.id, task.executor],
  );

  if (!executor || executor.kind === 'notify') return null;

  if (nomiExec && nomiBinding) {
    return (
      <div className={styles.wrap} data-testid={`task-model-switch-${placement}`}>
        <NomiModelSwitch binding={nomiBinding} />
      </div>
    );
  }

  if (!cliExec) return null;

  if (liveTab) {
    return (
      <div className={styles.wrap} data-testid={`task-model-switch-${placement}`}>
        <ModelControls
          key={`task-cli-${liveTab.id}`}
          tab={liveTab}
          onTabUpdated={handleTabUpdated}
        />
      </div>
    );
  }

  const ex = cliExec;
  const activeCliOpt =
    cliOpt && cliOpt.taskId === task.id && cliOpt.baseUpdatedAt === task.updatedAt ? cliOpt : null;
  const preset = ex.presetId
    ? delegateState?.presets?.find((p) => p.id === ex.presetId)
    : undefined;
  const resolvedCli = (activeCliOpt?.spec.cli || ex.cli || preset?.cli || 'claude') as DelegateCli;
  const rawSource =
    activeCliOpt?.spec.source ??
    ex.source ??
    preset?.source ??
    (localOnly(resolvedCli) ? 'local' : thirdPartyOnly(resolvedCli) ? 'thirdParty' : 'official');
  const resolvedSource: RunnerSource =
    rawSource === 'local' || rawSource === 'official' || rawSource === 'thirdParty'
      ? rawSource
      : 'official';
  const sameCliAsPreset = !preset || !ex.cli || ex.cli === preset.cli;
  const resolvedAccountId =
    resolvedSource === 'official'
      ? (activeCliOpt?.spec.accountId ??
        ex.accountId ??
        (sameCliAsPreset ? preset?.accountId : null) ??
        null)
      : null;
  const resolvedModel =
    activeCliOpt?.spec.model !== undefined
      ? activeCliOpt.spec.model
      : (ex.model ?? (sameCliAsPreset ? preset?.model : null) ?? null);
  const resolvedEffort = (
    activeCliOpt?.spec.reasoningEffort !== undefined
      ? activeCliOpt.spec.reasoningEffort
      : (ex.reasoningEffort ?? (sameCliAsPreset ? preset?.reasoningEffort : null) ?? null)
  ) as RunnerEffort | null;

  const pickerValue: RunnerSpecValue = {
    cli: resolvedCli,
    source: resolvedSource,
    accountId: resolvedAccountId,
    model: resolvedModel,
    reasoningEffort: resolvedEffort,
  };

  const modelPart =
    resolvedSource === 'thirdParty'
      ? resolvedModel
        ? refSlashLabel(gateway, resolvedModel)
        : t('ui.cli-monitor.third-party')
      : resolvedModel || t('ui.providers-schedule.default-model');
  const effortPart = resolvedEffort ? thinkingLevelLabel(resolvedEffort) : null;
  const usePresetPrefix =
    !activeCliOpt && preset && !ex.source && !ex.accountId && !ex.model && !ex.reasoningEffort;
  const summaryParts = [
    usePresetPrefix ? presetDisplayLabel(preset) : null,
    modelPart,
    effortPart,
  ].filter(Boolean);
  const label = summaryParts.join(' · ');
  const chipTestId = placement === 'settings' ? 'task-settings-cli-model' : 'task-cli-model';

  return (
    <div className={styles.wrap} data-testid={`task-model-switch-${placement}`}>
      <button
        type="button"
        className={styles.chip}
        data-variant={placement === 'settings' ? 'outlined' : undefined}
        aria-label={t('ui.chat-settings.switch-model', label)}
        data-testid={chipTestId}
        onClick={() => setPickerOpen(true)}
      >
        <EndpointIcon backend={resolvedCli} size={14} decorative />
        <span className={styles.label}>{label}</span>
        <Icon icon={ChevronDown} size={12} />
      </button>
      {pickerOpen && (
        <RunnerModelPicker
          open
          lockCli
          value={pickerValue}
          installed={delegateState?.installed}
          localAvailable={delegateState?.localAvailable}
          gateway={gateway}
          onConfirm={(next) => {
            setPickerOpen(false);
            setCliOpt({ taskId: task.id, baseUpdatedAt: task.updatedAt, spec: next });
            void tasksApi
              .update({
                id: task.id,
                source: next.source,
                accountId: next.source === 'official' ? (next.accountId ?? null) : null,
                model: next.model ?? null,
                reasoningEffort: next.reasoningEffort ?? null,
                presetId: null,
              })
              .catch(() => setCliOpt(null));
          }}
          onClose={() => setPickerOpen(false)}
          onOpenProviders={onOpenProviders}
        />
      )}
    </div>
  );
};
