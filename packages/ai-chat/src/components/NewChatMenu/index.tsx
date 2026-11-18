/**
 * 唯一的「新建」菜单：侧栏「新对话」与标签栏「+」共用。
 * 端点（图标 + 名称，未安装置灰）+ 项目（新会话放进哪个项目）。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  IconFlame as Flame,
  IconLayersSubtract as CustomPresetIcon,
  IconLeaf as Leaf,
  IconScale as Scale,
} from '@tabler/icons-react';
import React, { useEffect, useRef } from 'react';

import {
  formatRunnerSummary,
  presetDisplayLabel,
  type RunnerPreset,
} from '../../services/delegateClient';
import type { GatewayState } from '../../services/gatewayClient';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';
import { ProjectPicker } from '../ProjectPicker';

import styles from './index.module.css';

function presetIcon(p: RunnerPreset) {
  if (p.id === 'high' || p.costTier === 'high') return Flame;
  if (p.id === 'balanced' || p.costTier === 'medium') return Scale;
  if (p.id === 'low' || p.costTier === 'low') return Leaf;
  return CustomPresetIcon;
}

export interface NewChatMenuProps {
  backends: readonly ConversationBackend[];
  /** 已探测到的 CLI 路径；null / 空 = 未安装；缺省键视为未知（可点） */
  bins: Record<string, string | null | undefined>;
  /** 把「未探测」也当作未安装（侧栏用） */
  strictBins?: boolean;
  lastBackend?: ConversationBackend | null;
  /** 新会话的项目（没选 = 不指定）；不传时不显示项目选择（如侧栏「最近」：新会话不在任何项目里） */
  project?: { chosen: string | undefined; set: (projectId: string) => void };
  onPick: (b: ConversationBackend) => void;
  presets?: readonly RunnerPreset[];
  gateway?: GatewayState | null;
  onPickPreset?: (preset: RunnerPreset) => void;
  testId?: string;
  itemTestId?: (b: ConversationBackend) => string;
  workspaceTestId?: string;
  className?: string;
  /** 正在收起：放淡出动画（usePresence） */
  closing?: boolean;
}

export const NewChatMenu: React.FC<NewChatMenuProps> = ({
  backends,
  bins,
  strictBins,
  lastBackend,
  project,
  onPick,
  presets,
  gateway,
  onPickPreset,
  testId = 'new-chat-menu',
  itemTestId = (b) => `new-chat-${b}`,
  workspaceTestId = 'new-chat-project',
  closing,
  className,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const missing = (b: ConversationBackend) =>
    b !== 'nomi' && (strictBins ? !bins[b] : bins[b] === null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const n = (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[n]?.focus();
    e.preventDefault();
  };

  const presetList = presets && onPickPreset ? presets : [];
  const hasVisiblePreset = presetList.some((p) => !missing(p.cli));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('ui.cli-monitor.new-conversation')}
      className={`${styles.menu} ${className ?? ''} cd-motion-pop`}
      data-closing={closing || undefined}
      data-testid={testId}
      onKeyDown={onKey}
    >
      {presetList.length > 0 && hasVisiblePreset && (
        <>
          <div className={styles.groupLabel} data-testid="new-chat-presets">
            {t('ui.models.new-chat-by-preset')}
          </div>
          {presetList.map((p) => {
            const disabled = missing(p.cli);
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className={styles.item}
                disabled={disabled}
                data-testid={`new-chat-preset-${p.id}`}
                onClick={() => onPickPreset?.(p)}
              >
                <span className={styles.name}>
                  <Icon icon={presetIcon(p)} size={15} />
                  <span>{presetDisplayLabel(p)}</span>
                </span>
                <span className={styles.hint}>
                  {disabled ? t('ui.mascot-theme.not-installed') : formatRunnerSummary(p, gateway)}
                </span>
              </button>
            );
          })}
          <div className={styles.divider} role="separator" />
        </>
      )}
      {backends.map((b) => (
        <button
          key={b}
          type="button"
          role="menuitem"
          className={styles.item}
          disabled={missing(b)}
          data-testid={itemTestId(b)}
          onClick={() => onPick(b)}
        >
          <span className={styles.name}>
            <EndpointIcon backend={b} size={16} decorative />
            {ENDPOINT_NAME[b]}
          </span>
          <span className={styles.hint}>
            {missing(b)
              ? t('ui.mascot-theme.not-installed')
              : b === lastBackend
                ? t('ui.mascot-theme.last-used')
                : ''}
          </span>
        </button>
      ))}
      {project && (
        <div className={styles.ws}>
          <ProjectPicker value={project.chosen} onChange={project.set} testId={workspaceTestId} />
        </div>
      )}
    </div>
  );
};
