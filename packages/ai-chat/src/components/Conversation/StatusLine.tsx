/** 运行中的等待态状态行：图标 + 明确文案 + 已用时 */
import { Icon } from '@nomi-ai/ui';
import {
  Bot,
  Brain,
  Clock,
  Hourglass,
  LoaderCircle,
  PenLine,
  RefreshCw,
  ShieldAlert,
  Shrink,
  Unplug,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import type { StatusInfo, StatusKind } from '../../utils/convStatus';
import { formatDuration } from '../../utils/toolTrace';

import styles from './index.module.css';

const ICONS: Record<StatusKind, LucideIcon> = {
  queued: Clock,
  permission: ShieldAlert,
  compact: Shrink,
  retry: RefreshCw,
  reconnect: Unplug,
  subagent: Bot,
  tool: LoaderCircle,
  thinking: Brain,
  'first-token': Hourglass,
  writing: PenLine,
  working: LoaderCircle,
};

/** 这些状态的图标持续旋转 */
const SPIN = new Set<StatusKind>(['tool', 'working', 'retry', 'reconnect', 'compact']);
const WARN = new Set<StatusKind>(['permission', 'retry', 'reconnect']);

export const StatusLine: React.FC<{
  status: StatusInfo;
  startedAt?: number;
}> = ({ status, startedAt }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : undefined;
  const cls = [styles.status, WARN.has(status.kind) ? styles.statusWarn : ''].join(' ');
  return (
    <div className={cls} data-testid="conv-status" data-kind={status.kind} role="status">
      <span className={`${styles.statusIcon} ${SPIN.has(status.kind) ? styles.statusSpin : ''}`}>
        <Icon icon={ICONS[status.kind]} size={14} />
      </span>
      <span>{status.label}</span>
      {status.detail && <span className={styles.statusDetail}>{status.detail}</span>}
      {elapsed !== undefined && elapsed >= 1000 && status.kind !== 'queued' && (
        <span className={styles.statusTime}>
          {formatDuration(Math.floor(elapsed / 1000) * 1000)}
        </span>
      )}
    </div>
  );
};
