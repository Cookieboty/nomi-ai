/**
 * 某个 agent 详情中的「新会话默认」与「第三方模型」卡片：
 * - 多源助手展示「新会话默认」切换，与下方的第三方主模型配置并存互不清空；
 * - 仅第三方助手（如 Gemini CLI / dsh）隐藏重复的新会话来源行，直接选择第三方主模型；
 * - 网关无已启用模型时提供直达「三方模型」添加供应商的按钮；
 * - 支持就地展开各档模型（Claude 的 Opus/Sonnet/Haiku/Fable + 子代理）与辅助模型。
 */
import { Button, Icon, IconButton, ModelPicker, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import {
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
} from '@tabler/icons-react';
import React, { useMemo, useState } from 'react';

import type { CliKind } from '../../services/cliSource';
import { gatewayClient, type ClientModels } from '../../services/gatewayClient';
import { pickerProviders, useGatewayState } from '../../services/nomiModel';
import { hasOfficialAccount, thirdPartyOnly } from '../../utils/cliCaps';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

import styles from './index.module.css';
import { NewTabSourceRow } from './NewTabSourceRow';

const UNSET = 'unset';
const FOLLOW = 'follow';
const NOT_SET = [{ value: UNSET, label: 'ui.cli-monitor.not-set' }];
const FOLLOW_MAIN = [{ value: FOLLOW, label: 'ui.models.follow-main-model' }];

type TierId = keyof NonNullable<ClientModels['tiers']>;
type ModelsPatch = Partial<Omit<Record<keyof ClientModels, string | null>, 'tiers'>> & {
  tiers?: Partial<Record<TierId, string | null>>;
};
type CliAssignPatch = {
  models?: ModelsPatch;
  newTabSource?: 'local' | 'official' | 'thirdParty';
  newTabAccountId?: string | null;
};

const CLAUDE_TIERS: ReadonlyArray<{ id: TierId; label: string }> = [
  { id: 'opus', label: 'ui.models.opus-tier' },
  { id: 'sonnet', label: 'ui.models.sonnet-tier' },
  { id: 'haiku', label: 'ui.models.haiku-tier-background-tasks' },
  { id: 'fable', label: 'ui.models.fable-tier' },
];

export const CliThirdPartyModelsCard: React.FC<{
  kind: CliKind;
  onOpenModels?: () => void;
}> = ({ kind, onOpenModels }) => {
  const gateway = useGatewayState();
  const [open, setOpen] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const providers = useMemo(() => gateway?.providers ?? [], [gateway]);
  const picker = useMemo(() => pickerProviders(providers), [providers]);

  const name = t(ENDPOINT_NAME[kind]);
  const supportsOfficial = hasOfficialAccount(kind);
  const client = gateway?.clients[kind];
  const m = client?.models ?? {};
  // eslint-disable-next-line nomi/no-cli-literal -- 各档模型（opus / sonnet / haiku / fable / subagent）是 Claude Code 独有的配置
  const claude = kind === 'claude';

  const assign = (patch: CliAssignPatch) => {
    setSaveErr(null);
    gatewayClient
      .setAssignment(kind, patch as Parameters<typeof gatewayClient.setAssignment>[1])
      .catch((e: unknown) => setSaveErr(e instanceof Error ? e.message : String(e)));
  };

  const setMain = (v: string) => {
    if (v !== UNSET) {
      assign(
        thirdPartyOnly(kind)
          ? { models: { main: v }, newTabSource: 'thirdParty', newTabAccountId: null }
          : { models: { main: v } },
      );
      return;
    }
    assign({
      models: { main: null },
      ...((client?.newTabSource ?? 'official') === 'thirdParty' && supportsOfficial
        ? { newTabSource: 'official' }
        : {}),
    });
  };

  const tierValue = (id: TierId) => m.tiers?.[id] ?? (id === 'haiku' ? m.small : undefined);
  const setTier = (id: TierId, v: string) =>
    assign({
      models: {
        tiers: { ...m.tiers, [id]: v === FOLLOW ? null : v },
        ...(id === 'haiku' && m.small ? { small: null } : {}),
      },
    });

  return (
    <SettingsGroup
      data-testid={`cli-third-party-${kind}`}
      actions={
        picker.length > 0 && onOpenModels ? (
          <Button size="sm" variant="ghost" onClick={onOpenModels} data-testid="cli-open-models">
            {t('ui.models.manage-providers')}
          </Button>
        ) : undefined
      }
    >
      {supportsOfficial && <NewTabSourceRow kind={kind} />}

      <SettingRow
        title={t('ui.models.third-party-models')}
        description={
          <>
            {t('ui.providers-schedule.requests-go-through-the-nomi-gateway-which-converts', name)}
            {saveErr && (
              <span className={styles.rowError} role="alert">
                {saveErr}
              </span>
            )}
          </>
        }
      >
        {picker.length > 0 ? (
          <div className={styles.tpMainCtrl}>
            <ModelPicker
              providers={picker}
              purpose="coding"
              size="sm"
              browse
              className={styles.tpPicker}
              extraOptions={NOT_SET}
              value={m.main ?? UNSET}
              onChange={setMain}
              aria-label={t('ui.models.third-party-model', name)}
              data-testid={`cli-main-${kind}`}
            />
            <IconButton
              size="sm"
              aria-expanded={open}
              label={`${name} · ${claude ? t('ui.models.per-tier-models') : t('ui.voice-mascot.more')}`}
              data-testid={claude ? 'cli-tiers-toggle' : `cli-more-${kind}`}
              onClick={() => setOpen((v) => !v)}
              icon={<Icon icon={open ? ChevronDown : ChevronRight} size={14} />}
            />
          </div>
        ) : onOpenModels ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenModels}
            data-testid="cli-open-models"
          >
            {t('ui.models.add-third-party-provider')}
          </Button>
        ) : (
          <span className={styles.sub}>{t('ui.cli-monitor.not-set')}</span>
        )}
      </SettingRow>

      {picker.length > 0 && open && (
        <div className={styles.cliTiers} data-testid={`cli-tiers-panel-${kind}`}>
          {claude &&
            CLAUDE_TIERS.map((tier) => (
              <div className={styles.tierField} key={tier.id}>
                <span className={styles.tierLabel}>{t(tier.label)}</span>
                <ModelPicker
                  providers={picker}
                  purpose="coding"
                  size="sm"
                  browse
                  className={styles.tpPicker}
                  extraOptions={FOLLOW_MAIN}
                  value={tierValue(tier.id) ?? FOLLOW}
                  onChange={(v) => setTier(tier.id, v)}
                  aria-label={t('ui.models.claude-code', t(tier.label))}
                  data-testid={`cli-tier-${tier.id}`}
                />
              </div>
            ))}
          {claude && (
            <div className={styles.tierField}>
              <span className={styles.tierLabel}>{t('ui.usage-tools.subagent')}</span>
              <ModelPicker
                providers={picker}
                purpose="coding"
                size="sm"
                browse
                className={styles.tpPicker}
                extraOptions={FOLLOW_MAIN}
                value={m.subagent ?? FOLLOW}
                onChange={(v) => assign({ models: { subagent: v === FOLLOW ? null : v } })}
                aria-label={t('ui.models.claude-code-subagent-model')}
                data-testid="cli-subagent"
              />
            </div>
          )}
          <div className={styles.tierField}>
            <span className={styles.tierLabel}>{t('ui.usage-tools.helper-model')}</span>
            <ModelPicker
              providers={picker}
              purpose="coding"
              size="sm"
              browse
              className={styles.tpPicker}
              extraOptions={FOLLOW_MAIN}
              value={m.summary ?? FOLLOW}
              onChange={(v) => assign({ models: { summary: v === FOLLOW ? null : v } })}
              aria-label={t('ui.models.helper-model-titles-summaries-etc', name)}
              data-testid={`cli-helper-${kind}`}
            />
          </div>
        </div>
      )}
    </SettingsGroup>
  );
};
