/**
 * 斜杠命令面板：按来源分组、模糊搜索高亮、参数提示、接管方式标签。
 * 键盘（↑↓ Enter Tab Esc）由输入框处理，这里只负责展示与鼠标选择。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useRef } from 'react';

import type { AgentOption } from '../../slash/agentComplete';
import { kindLabel, sourceLabel } from '../../slash/cards';
import type { SlashGroup } from '../../slash/registry';
import type { ModelArgOption, SlashCommand } from '../../slash/types';
import type { Range } from '../../utils/fuzzy';
import { EndpointIcon } from '../EndpointIcon';

import styles from './index.module.css';

const highlight = (text: string, ranges: Range[]) => {
  if (!ranges.length) return text;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={i}>{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
};

interface Props {
  groups: readonly SlashGroup[];
  /** 扁平序号（跨分组） */
  active: number;
  query: string;
  /** 查询正好是一条当前端不支持的命令：不列入菜单，但说明它是 CLI 自己的 */
  blocked?: string;
  onPick: (c: SlashCommand) => void;
  onHover: (flatIndex: number) => void;
}

export const SlashPalette: React.FC<Props> = ({
  groups,
  active,
  query,
  blocked,
  onPick,
  onHover,
}) => {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, groups]);
  let flat = -1;
  if (!groups.length)
    return (
      <div className={styles.menu} role="menu" data-testid="slash-menu">
        <div className={styles.empty} data-testid="slash-empty">
          {blocked
            ? t('ui.slash-commands.is-a-built-in-cli-command-and-is', blocked)
            : t('ui.slash-commands.no-command-named-enter-will-not-send-it', query)}
        </div>
      </div>
    );
  return (
    <div
      className={styles.menu}
      role="menu"
      data-testid="slash-menu"
      aria-label={t('ui.slash-commands.slash-commands')}
    >
      {groups.map((g) => (
        <div key={g.source} role="group" aria-label={sourceLabel(g.source)} data-group={g.source}>
          <div className={styles.group}>{sourceLabel(g.source)}</div>
          {g.items.map(({ command: c, ranges }) => {
            const i = ++flat;
            const on = i === active;
            return (
              <button
                key={c.id}
                ref={on ? activeRef : undefined}
                type="button"
                role="menuitem"
                className={`${styles.item} ${on ? styles.on : ''}`}
                data-kind={c.kind}
                {...(c.disabled ? { 'data-disabled': 'true', title: c.disabled.reason } : {})}
                data-testid={`slash-${c.name}`}
                aria-current={on ? 'true' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => !on && onHover(i)}
                onClick={() => onPick(c)}
              >
                <span className={styles.name}>
                  /{highlight(c.name, ranges)}
                  {c.args && <span className={styles.args}> {c.args.hint}</span>}
                </span>
                <span className={styles.desc}>
                  {c.disabled ? c.disabled.reason : c.description}
                </span>
                {c.badge && <span className={styles.badge}>{c.badge}</span>}
                <span className={styles.kind}>
                  {c.disabled ? t('ui.slash-commands.unavailable') : kindLabel(c.kind)}
                </span>
              </button>
            );
          })}
        </div>
      ))}
      <div className={styles.foot} aria-hidden="true">
        {t('ui.slash-commands.select-enter-run-tab-complete-esc-close')}
      </div>
    </div>
  );
};

interface AgentProps {
  options: readonly AgentOption[];
  active: number;
  onPick: (o: AgentOption) => void;
  onHover: (i: number) => void;
}

/** `/agent ` 后的编程助手列表：沿用命令面板的样式；没安装的置灰、不可选 */
export const AgentPalette: React.FC<AgentProps> = ({ options, active, onPick, onHover }) => {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, options]);
  return (
    <div
      className={styles.menu}
      role="menu"
      data-testid="slash-agent-menu"
      aria-label={t('ui.providers-schedule.coding-agents')}
    >
      <div className={styles.group}>{t('ui.providers-schedule.coding-agents')}</div>
      {options.length === 0 && (
        <div className={styles.empty} data-testid="slash-agent-empty">
          {t('ui.slash-commands.no-matching-coding-agent')}
        </div>
      )}
      {options.map((o, i) => {
        const on = i === active;
        return (
          <button
            key={o.id}
            ref={on ? activeRef : undefined}
            type="button"
            role="menuitem"
            className={`${styles.item} ${on ? styles.on : ''}`}
            data-testid={`slash-agent-${o.id}`}
            aria-current={on ? 'true' : undefined}
            disabled={!o.installed}
            {...(o.installed ? {} : { 'data-disabled': 'true', 'aria-disabled': true })}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => !on && onHover(i)}
            onClick={() => o.installed && onPick(o)}
          >
            <EndpointIcon backend={o.id} size={16} decorative />
            <span className={styles.name}>{o.name}</span>
            <span className={styles.desc}>{o.id}</span>
            {!o.installed && (
              <span className={styles.kind}>{t('ui.mascot-theme.not-installed')}</span>
            )}
          </button>
        );
      })}
      <div className={styles.foot} aria-hidden="true">
        {t('ui.slash-commands.select-enter-tab-choose-esc-close')}
      </div>
    </div>
  );
};

interface ModelProps {
  /** null = 还在读模型列表 */
  options: readonly ModelArgOption[] | null;
  active: number;
  onPick: (o: ModelArgOption) => void;
  onHover: (i: number) => void;
}

/** `/model ` 后的模型列表：沿用命令面板的样式；当前在用的标「当前」 */
export const ModelArgPalette: React.FC<ModelProps> = ({ options, active, onPick, onHover }) => {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, options]);
  return (
    <div
      className={styles.menu}
      role="menu"
      data-testid="slash-model-menu"
      aria-label={t('ui.foundation.model')}
    >
      <div className={styles.group}>{t('ui.foundation.model')}</div>
      {options?.length === 0 && (
        <div className={styles.empty} data-testid="slash-model-empty">
          {t('ui.slash-commands.no-matching-model')}
        </div>
      )}
      {options?.map((o, i) => {
        const on = i === active;
        return (
          <button
            key={o.value}
            ref={on ? activeRef : undefined}
            type="button"
            role="menuitem"
            className={`${styles.item} ${on ? styles.on : ''}`}
            data-testid={`slash-model-${o.value}`}
            aria-current={on ? 'true' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => !on && onHover(i)}
            onClick={() => onPick(o)}
          >
            <span className={styles.name}>{o.label}</span>
            {o.hint && <span className={styles.desc}>{o.hint}</span>}
            {o.active && <span className={styles.kind}>{t('ui.providers-schedule.current')}</span>}
          </button>
        );
      })}
      <div className={styles.foot} aria-hidden="true">
        {t('ui.slash-commands.select-enter-tab-choose-esc-close')}
      </div>
    </div>
  );
};
