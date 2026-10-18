/**
 * 斜杠命令面板：按来源分组、模糊搜索高亮、参数提示、接管方式标签。
 * 键盘（↑↓ Enter Tab Esc）由输入框处理，这里只负责展示与鼠标选择。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useRef } from 'react';

import { kindLabel, sourceLabel } from '../../slash/cards';
import type { SlashGroup } from '../../slash/registry';
import type { SlashCommand } from '../../slash/types';
import type { Range } from '../../utils/fuzzy';

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
  onPick: (c: SlashCommand) => void;
  onHover: (flatIndex: number) => void;
}

export const SlashPalette: React.FC<Props> = ({ groups, active, query, onPick, onHover }) => {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, groups]);
  let flat = -1;
  if (!groups.length)
    return (
      <div className={styles.menu} role="menu" data-testid="slash-menu">
        <div className={styles.empty} data-testid="slash-empty">
          {t('没有叫 /{0} 的命令。按 Enter 不会发给模型；想发送普通文字请以 // 开头。', query)}
        </div>
      </div>
    );
  return (
    <div className={styles.menu} role="menu" data-testid="slash-menu" aria-label={t('斜杠命令')}>
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
                <span className={styles.desc}>{c.description}</span>
                {c.badge && <span className={styles.badge}>{c.badge}</span>}
                <span className={styles.kind}>{kindLabel(c.kind)}</span>
              </button>
            );
          })}
        </div>
      ))}
      <div className={styles.foot} aria-hidden="true">
        {t('↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭')}
      </div>
    </div>
  );
};
