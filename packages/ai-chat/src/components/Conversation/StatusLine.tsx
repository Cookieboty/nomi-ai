/** 运行中的等待态状态行：图标 + 步骤进度 + 明确文案 + 已用时 */
import { Icon, t } from '@nomi-ai/ui';
import {
  IconRobot as Bot,
  IconBrain as Brain,
  IconClock as Clock,
  IconHourglass as Hourglass,
  IconLoader2 as LoaderCircle,
  IconEdit as PenLine,
  IconRefresh as RefreshCw,
  IconShieldExclamation as ShieldAlert,
  IconArrowsMinimize as Shrink,
  IconPlugOff as Unplug,
} from '@tabler/icons-react';
import type { TablerIcon as IconGlyph } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';

import type { StatusInfo, StatusKind } from '../../utils/convStatus';
import { formatDuration } from '../../utils/toolTrace';

import styles from './index.module.css';

const ICONS: Record<StatusKind, IconGlyph> = {
  queued: Clock,
  permission: ShieldAlert,
  compact: Shrink,
  blocked: ShieldAlert,
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
const WARN = new Set<StatusKind>(['permission', 'retry', 'reconnect', 'blocked']);

export const isWarnStatus = (kind: StatusKind): boolean => WARN.has(kind);

/** 纯行内状态内容（只含 span 与 Icon，便于 StatusLine 与折叠横条复用） */
export const StatusLineContent: React.FC<{
  status: StatusInfo;
  startedAt?: number;
  stepCount?: number;
  minimal?: boolean;
}> = ({ status, startedAt, stepCount, minimal }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : undefined;
  const showTime =
    elapsed !== undefined && status.kind !== 'queued' && (minimal || elapsed >= 1000);
  return (
    <>
      <span className={`${styles.statusIcon} ${SPIN.has(status.kind) ? styles.statusSpin : ''}`}>
        <Icon icon={ICONS[status.kind]} size={14} />
      </span>
      {stepCount !== undefined && stepCount > 0 && (
        <span className={styles.statusStep} data-testid="conv-status-step">
          {t('ui.usage-tools.step-n', stepCount)}
        </span>
      )}
      <span className={styles.statusLabel}>{status.label}</span>
      {status.detail && <span className={styles.statusDetail}>{status.detail}</span>}
      {showTime && (
        <span className={styles.statusTime} data-testid="conv-status-time">
          {elapsed < 1000 ? '0s' : formatDuration(Math.floor(elapsed / 1000) * 1000)}
        </span>
      )}
    </>
  );
};

export const StatusLine: React.FC<{
  status: StatusInfo;
  startedAt?: number;
  stepCount?: number;
  minimal?: boolean;
}> = (props) => {
  const cls = [styles.status, isWarnStatus(props.status.kind) ? styles.statusWarn : ''].join(' ');
  return (
    <div
      className={cls}
      data-testid="conv-status"
      data-kind={props.status.kind}
      data-no-selection-toolbar=""
      role="status"
    >
      <StatusLineContent {...props} />
    </div>
  );
};
