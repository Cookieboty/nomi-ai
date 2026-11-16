import React from 'react';

import type { AgentOption } from '../../slash/agentComplete';
import type { AtPathOption } from '../../slash/atPathComplete';
import type { SlashGroup } from '../../slash/registry';
import type { ModelArgOption, SlashCommand } from '../../slash/types';
import { AtPathPalette } from '../AtPathPalette';
import { AgentPalette, ModelArgPalette, SlashPalette } from '../SlashPalette';

import styles from './index.module.css';

interface ComposerPalettesProps {
  slashOpen: boolean;
  slashGroups: readonly SlashGroup[];
  slashFlatLength: number;
  slashIdx: number;
  slashQuery: string | null;
  blockedSlash: string | undefined;
  onPickCommand: (c: SlashCommand) => void;
  onHoverCommand: (idx: number) => void;
  agentOpen: boolean;
  agentOptions: AgentOption[];
  agentIdx: number;
  onPickAgent: (o: AgentOption) => void;
  onHoverAgent: (idx: number) => void;
  modelOpen: boolean;
  modelOptions: ModelArgOption[];
  modelLoading: boolean;
  modelIdx: number;
  onPickModel: (o: ModelArgOption) => void;
  onHoverModel: (idx: number) => void;
  atOpen: boolean;
  atOptions: AtPathOption[];
  atIdx: number;
  onPickAtPath: (o: AtPathOption) => void;
  onHoverAtPath: (idx: number) => void;
  argHint: SlashCommand | null;
}

/** 输入框上方的四类补全面板（`/`、`/agent`、`/model`、`@`）与参数提示 */
export const ComposerPalettes: React.FC<ComposerPalettesProps> = ({
  slashOpen,
  slashGroups,
  slashFlatLength,
  slashIdx,
  slashQuery,
  blockedSlash,
  onPickCommand,
  onHoverCommand,
  agentOpen,
  agentOptions,
  agentIdx,
  onPickAgent,
  onHoverAgent,
  modelOpen,
  modelOptions,
  modelLoading,
  modelIdx,
  onPickModel,
  onHoverModel,
  atOpen,
  atOptions,
  atIdx,
  onPickAtPath,
  onHoverAtPath,
  argHint,
}) => (
  <>
    {slashOpen && (
      <SlashPalette
        groups={slashGroups}
        active={Math.min(slashIdx, Math.max(0, slashFlatLength - 1))}
        query={slashQuery ?? ''}
        {...(blockedSlash ? { blocked: blockedSlash } : {})}
        onPick={onPickCommand}
        onHover={onHoverCommand}
      />
    )}
    {agentOpen && (
      <AgentPalette
        options={agentOptions}
        active={Math.min(agentIdx, Math.max(0, agentOptions.length - 1))}
        onPick={onPickAgent}
        onHover={onHoverAgent}
      />
    )}
    {modelOpen && (
      <ModelArgPalette
        options={modelLoading ? null : modelOptions}
        active={Math.min(modelIdx, Math.max(0, modelOptions.length - 1))}
        onPick={onPickModel}
        onHover={onHoverModel}
      />
    )}
    {atOpen && (
      <AtPathPalette
        options={atOptions}
        active={Math.min(atIdx, Math.max(0, atOptions.length - 1))}
        onPick={onPickAtPath}
        onHover={onHoverAtPath}
      />
    )}
    {argHint?.args && (
      <div className={styles.slashHint} data-testid="slash-arg-hint">
        <code>
          /{argHint.name} {argHint.args.hint}
        </code>
        <span>{argHint.description}</span>
      </div>
    )}
  </>
);
