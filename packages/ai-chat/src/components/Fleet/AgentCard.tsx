import { brand } from '@nomi-ai/types';
import { Button, Icon, IconButton, t } from '@nomi-ai/ui';
import {
  AlertTriangle,
  CircleAlert,
  CornerDownRight,
  Cpu,
  Folder,
  Hourglass,
  MemoryStick,
  MoreHorizontal,
  Pause,
  PauseCircle,
  Play,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import {
  dirName,
  FLEET_COLUMNS,
  formatBytes,
  formatCpu,
  iconBackend,
  NEEDS_YOU_LABEL,
  ORIGIN_LABEL,
  type FleetAgent,
} from '../../services/fleetClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { fmtAgo } from '../../utils/relativeTime';
import { EndpointIcon } from '../EndpointIcon';

import board from './Board.module.css';
import styles from './Fleet.module.css';

const PAUSED_LABEL = {
  memory: 'ui.cli-monitor.fleet-paused-memory',
  user: 'ui.cli-monitor.fleet-paused-user',
  nomi: 'ui.cli-monitor.fleet-paused-nomi',
} as const;

/** 后台 Nomi 的暂停是任务暂停：这一轮还在跑时跑完才停；不随内存恢复自动继续 */
function pausedLabel(a: FleetAgent, by: keyof typeof PAUSED_LABEL) {
  if (a.kind !== 'nomi') return PAUSED_LABEL[by];
  if (a.column === 'running') return 'ui.cli-monitor.fleet-paused-after-turn';
  return by === 'nomi' ? 'ui.cli-monitor.fleet-paused-nomi-run' : PAUSED_LABEL[by];
}

const QUEUE_LABEL = {
  memory: 'ui.cli-monitor.fleet-held',
  cpu: 'ui.cli-monitor.fleet-held-cpu',
  slot: 'ui.cli-monitor.fleet-queue-slot',
  retry: 'ui.cli-monitor.fleet-queue-retry-soon',
} as const;

const COLUMN_LABEL = Object.fromEntries(FLEET_COLUMNS.map((c) => [c.key, c.label])) as Record<
  FleetAgent['column'],
  string
>;

export interface CardActions {
  onOpenTab?: (tabId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenChat?: (conversationId: string) => void;
  onArchive?: (id: string) => void;
  onCloseTab?: (a: FleetAgent) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  /** Nomi 对话的名称（视图的会话列表里取）；取不到返回空 */
  chatName?: (conversationId: string) => string;
  /** 调度树：上一级的标题（后台 Nomi 运行派出的编程助手显示「由「…」派出」） */
  parentTitle?: (id: string) => string;
}

/** 卡片标题：Nomi 对话用会话名；没有标题的写助手名 */
export function agentTitle(a: FleetAgent, chatName?: (id: string) => string): string {
  if (a.origin === 'chat') {
    return (a.conversationId && chatName?.(a.conversationId)) || t('ui.chat-settings.new-chat');
  }
  return a.title || t(ENDPOINT_NAME[iconBackend(a)]);
}

/** 资源占用一行（标题栏浮层也用） */
export const UsageLine: React.FC<{ a: FleetAgent }> = ({ a }) => {
  if (a.usage) {
    return (
      <span className={styles.usage}>
        <span>{t('ui.cli-monitor.fleet-memory', formatBytes(a.usage.rssBytes))}</span>
        <span>{t('ui.cli-monitor.fleet-cpu', formatCpu(a.usage.cpuPercent))}</span>
        {a.usage.processes > 1 && (
          <span>{t('ui.cli-monitor.fleet-processes', a.usage.processes)}</span>
        )}
      </span>
    );
  }
  // Nomi 对话与后台 agent 跑在内核进程里，单独的占用量不出来；外部会话没对上进程时不写
  if (a.kind === 'nomi') {
    return (
      <span className={styles.usage}>{t('ui.cli-monitor.fleet-usage-unknown', brand.appName)}</span>
    );
  }
  return null;
};

/** 卡片右下角的占用：图标 + 数字（量不到时不写，不编数） */
const CardUsage: React.FC<{ a: FleetAgent }> = ({ a }) => {
  if (!a.usage) {
    return a.kind === 'nomi' ? (
      <span className={board.usage} title={t('ui.cli-monitor.fleet-usage-unknown', brand.appName)}>
        {t('ui.cli-monitor.fleet-usage-in-kernel', brand.appName)}
      </span>
    ) : null;
  }
  return (
    <span className={board.usage}>
      <span className={board.usageItem}>
        <Icon icon={Cpu} size={12} />
        {t('ui.cli-monitor.fleet-cpu', formatCpu(a.usage.cpuPercent))}
      </span>
      <span className={board.usageItem}>
        <Icon icon={MemoryStick} size={12} />
        {t('ui.cli-monitor.fleet-memory', formatBytes(a.usage.rssBytes))}
      </span>
      {a.usage.processes > 1 && (
        <span>{t('ui.cli-monitor.fleet-processes', a.usage.processes)}</span>
      )}
    </span>
  );
};

interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  testId?: string;
}

/** 「⋯」菜单：卡片里的次要操作（打开、归档） */
const CardMenu: React.FC<{ id: string; items: MenuItem[] }> = ({ id, items }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // 只关菜单，不让整页的 Esc 退回对话
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [],
    );
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
    list[next]?.focus();
  };
  return (
    <div className={board.menuWrap} ref={ref} onKeyDown={onKey}>
      <IconButton
        ref={btn}
        size="sm"
        variant="ghost"
        icon={<Icon icon={MoreHorizontal} size={14} />}
        label={t('ui.cli-monitor.more-actions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`fleet-more-${id}`}
      />
      {open && (
        <div className={board.menu} role="menu" data-testid={`fleet-menu-${id}`}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={board.menuItem}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              data-testid={it.testId}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** 卡片状态：要你处理的优先，其次出错，其余按所在的列 */
function statusOf(a: FleetAgent): { tone: string; label: string } {
  if (a.needsYou) return { tone: 'attention', label: t(NEEDS_YOU_LABEL[a.needsYou]) };
  if (a.failed) return { tone: 'failed', label: t('ui.cli-monitor.fleet-failed') };
  return { tone: a.column, label: t(COLUMN_LABEL[a.column]) };
}

export const AgentCard: React.FC<{ a: FleetAgent } & CardActions> = ({
  a,
  onOpenTab,
  onOpenTask,
  onOpenChat,
  onArchive,
  onCloseTab,
  onPause,
  onResume,
  chatName,
  parentTitle,
}) => {
  const backend = iconBackend(a);
  const backendName = t(ENDPOINT_NAME[backend]);
  const external = a.scope === 'external';
  const status = statusOf(a);
  const parent = a.parentId ? parentTitle?.(a.parentId) : '';

  const menu: MenuItem[] = [];
  if (!external && a.tabId && onOpenTab) {
    menu.push({
      key: 'tab',
      label: t('ui.cli-monitor.open-tab'),
      onSelect: () => onOpenTab(a.tabId!),
    });
  }
  if (!external && !a.tabId && a.origin !== 'chat' && a.taskId && onOpenTask) {
    menu.push({
      key: 'task',
      label: t('ui.cli-monitor.fleet-open-task'),
      onSelect: () => onOpenTask(a.taskId!),
    });
  }
  if (a.origin === 'chat' && a.conversationId && onOpenChat) {
    menu.push({
      key: 'chat',
      label: t('ui.cli-monitor.fleet-open-chat'),
      onSelect: () => onOpenChat(a.conversationId!),
      testId: `fleet-open-chat-${a.id}`,
    });
  }
  if (a.column === 'done' && !a.needsYou && onArchive) {
    menu.push({
      key: 'archive',
      label: t('ui.cli-monitor.archive-chat'),
      onSelect: () => onArchive(a.id),
      testId: `fleet-archive-${a.id}`,
    });
  }
  // 关闭标签放在卡片右下角（不进「⋯」菜单）：做完了的、Nomi 管着的标签才有；外部会话只读
  const closable = !external && a.column === 'done' && !!a.tabId && !!onCloseTab;

  return (
    <li
      className={board.card}
      data-column={a.column}
      data-scope={a.scope}
      data-tone={status.tone}
      data-testid={`fleet-card-${a.id}`}
    >
      <div className={board.cardHead}>
        <EndpointIcon backend={backend} size={32} decorative />
        <span className={board.name}>{backendName}</span>
        <span className={board.status} data-tone={status.tone}>
          <span className={board.dot} aria-hidden />
          {status.label}
        </span>
        <span className={board.headSpacer} />
        {a.paused && onResume && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={<Icon icon={Play} size={14} />}
            label={t('ui.cli-monitor.fleet-resume')}
            onClick={() => onResume(a.id)}
            data-testid={`fleet-resume-${a.id}`}
          />
        )}
        {a.pausable && onPause && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={<Icon icon={Pause} size={14} />}
            label={t('ui.providers-schedule.task-pause')}
            onClick={() => onPause(a.id)}
            data-testid={`fleet-pause-${a.id}`}
          />
        )}
        {menu.length > 0 && <CardMenu id={a.id} items={menu} />}
      </div>

      <span className={board.title} title={agentTitle(a, chatName)}>
        {agentTitle(a, chatName)}
      </span>

      <span className={board.meta}>
        <span>
          {external
            ? t('ui.cli-monitor.fleet-readonly', t(ORIGIN_LABEL[a.origin]))
            : t(ORIGIN_LABEL[a.origin])}
        </span>
        {a.cwd && (
          <span className={board.metaItem} title={a.cwd}>
            <Icon icon={Folder} size={12} />
            {dirName(a.cwd)}
          </span>
        )}
        {parent && (
          <span className={board.metaItem} data-testid={`fleet-parent-${a.id}`}>
            <Icon icon={CornerDownRight} size={12} />
            {t('ui.cli-monitor.fleet-dispatched-by', parent)}
          </span>
        )}
      </span>

      {a.queueReason && (
        <span
          className={board.note}
          data-tone={a.queueReason === 'memory' || a.queueReason === 'cpu' ? 'warning' : undefined}
          data-testid={`fleet-queue-${a.id}`}
        >
          <Icon icon={Hourglass} size={12} />
          {a.queueReason === 'retry' && a.retryAt
            ? t(
                'ui.cli-monitor.fleet-queue-retry',
                new Date(a.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              )
            : t(QUEUE_LABEL[a.queueReason])}
        </span>
      )}
      {a.needsYou && (
        <span className={board.note} data-tone="warning" data-testid={`fleet-needs-${a.id}`}>
          <Icon icon={CircleAlert} size={12} />
          {t(NEEDS_YOU_LABEL[a.needsYou])}
        </span>
      )}
      {a.paused && (
        <span className={board.note} data-tone="warning" data-testid={`fleet-paused-${a.id}`}>
          <Icon icon={PauseCircle} size={12} />
          {t(pausedLabel(a, a.paused.by))}
        </span>
      )}
      {a.failed && (
        <span className={board.note} data-tone="danger">
          <Icon icon={AlertTriangle} size={12} />
          {t('ui.cli-monitor.fleet-failed')}
        </span>
      )}
      {a.summary && (
        <span className={board.summary} data-testid={`fleet-summary-${a.id}`}>
          {a.summary}
        </span>
      )}

      {/* 进行中的只画一条流动的线，表示「在跑」：内核没有完成度，不画百分比 */}
      <span className={board.track} data-column={a.column} aria-hidden />

      <span className={board.foot}>
        <span className={board.updated}>
          {t('ui.cli-monitor.fleet-updated', fmtAgo(a.updatedAt))}
        </span>
        <CardUsage a={a} />
        {closable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onCloseTab!(a)}
            aria-label={t('ui.cli-monitor.fleet-close-tab', agentTitle(a, chatName))}
            data-testid={`fleet-close-tab-${a.id}`}
          >
            {t('ui.mascot-theme.close-tab-action')}
          </Button>
        )}
      </span>
    </li>
  );
};
