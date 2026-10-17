/**
 * 工具调用时间线（参考 Codex Desktop 的交互思路，自行实现）：
 * 紧凑单行（图标 + 动作摘要 + 状态 + 耗时）、连续调用折叠成分组、命令显示输出、
 * 编辑显示 diff、子代理独立折叠块、思考可折叠。默认折叠，点击展开参数与输出。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  ChevronsUp,
  CircleAlert,
  Compass,
  FileDiff as FileDiffIcon,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  LoaderCircle,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { memo, useEffect, useId, useState } from 'react';

import { thoughtLabel } from '../../utils/convTime';
import {
  callDuration,
  commandOf,
  describeCall,
  diffStats,
  diffsOf,
  formatDuration,
  groupDuration,
  groupStats,
  groupTitle,
  parseInput,
  type Bucket,
  type CallStatus,
  type TimelineItem,
  type ToolCall,
  type ToolKind,
} from '../../utils/toolTrace';

import { DiffView } from './DiffView';
import { Markdown } from './Markdown';
import styles from './Tool.module.css';

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  read: FileText,
  search: Search,
  list: FolderOpen,
  edit: FilePen,
  write: FilePlus,
  command: SquareTerminal,
  subagent: Bot,
  web: Globe,
  todo: ListChecks,
  other: Wrench,
};

const BUCKET_ICON: Record<Bucket, LucideIcon> = {
  explore: Compass,
  command: SquareTerminal,
  edit: FileDiffIcon,
  other: Wrench,
};

const StatusMark: React.FC<{ status: CallStatus }> = ({ status }) =>
  status === 'running' ? (
    <span className={`${styles.status} ${styles.spin}`} role="status" aria-label={t('运行中')}>
      <Icon icon={LoaderCircle} size={13} />
    </span>
  ) : status === 'error' ? (
    <span className={`${styles.status} ${styles.statusError}`} role="img" aria-label={t('失败')}>
      <Icon icon={CircleAlert} size={13} />
    </span>
  ) : (
    <span className={`${styles.status} ${styles.statusDone}`} role="img" aria-label={t('完成')}>
      <Icon icon={Check} size={13} />
    </span>
  );

/** 带展开 / 折叠的一行；header 是整行按钮 */
const Disclosure: React.FC<{
  icon: LucideIcon;
  label: React.ReactNode;
  meta?: React.ReactNode;
  status: CallStatus;
  duration?: number;
  defaultOpen?: boolean;
  /** 受控展开（思考块：流式时展开、完成后自动折叠） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId: string;
  attrs?: Record<string, string>;
  variant?: 'row' | 'group' | 'block';
  children: React.ReactNode;
}> = ({
  icon,
  label,
  meta,
  status,
  duration,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  testId,
  attrs,
  variant = 'row',
  children,
}) => {
  const [inner, setInner] = useState(defaultOpen);
  const open = controlled ?? inner;
  const setOpen = (fn: (v: boolean) => boolean) => {
    const v = fn(open);
    setInner(v);
    onOpenChange?.(v);
  };
  const bodyId = useId();
  return (
    <div
      className={`${styles.item} ${styles[variant]}`}
      data-testid={testId}
      data-status={status}
      data-open={open}
      {...attrs}
    >
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon icon={ChevronRight} size={13} className={styles.chevron} />
        <Icon icon={icon} size={14} className={styles.kindIcon} />
        <span className={styles.label}>{label}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
        <span className={styles.tail}>
          {duration !== undefined && status !== 'running' && (
            <span className={styles.duration}>{formatDuration(duration)}</span>
          )}
          <StatusMark status={status} />
        </span>
      </button>
      {open && (
        <div id={bodyId} className={styles.body}>
          {children}
        </div>
      )}
    </div>
  );
};

const Output: React.FC<{
  text?: string;
  label?: string;
  error?: boolean;
  testId?: string;
}> = ({ text, testId = 'tool-output', label, error }) => {
  if (!text) return null;
  return (
    <div className={styles.section}>
      {label && <div className={styles.sectionLabel}>{label}</div>}
      <pre
        className={`${styles.pre} ${error ? styles.preError : ''}`}
        data-testid={testId}
        tabIndex={0}
      >
        {text}
      </pre>
    </div>
  );
};

/** 参数：JSON 美化；非 JSON 原样 */
function prettyInput(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const o = parseInput(input);
  return o ? JSON.stringify(o, null, 2) : input;
}

const CallBody: React.FC<{ call: ToolCall }> = ({ call }) => {
  const d = describeCall(call);
  const err = call.status === 'error';
  if (d.kind === 'command') {
    const cmd = commandOf(call);
    return (
      <>
        {cmd && (
          <pre className={`${styles.pre} ${styles.cmd}`} data-testid="tool-command" tabIndex={0}>
            {`$ ${cmd}`}
          </pre>
        )}
        <Output text={call.output} error={err} />
        {!call.output && call.status === 'done' && (
          <div className={styles.empty}>{t('（无输出）')}</div>
        )}
      </>
    );
  }
  if (d.kind === 'edit' || d.kind === 'write') {
    const diffs = diffsOf(call);
    return (
      <>
        {diffs.map((f, i) => (
          <DiffView key={i} diff={f} />
        ))}
        {!diffs.length && <Output text={prettyInput(call.input)} label={t('参数')} />}
        {err && <Output text={call.output} error />}
      </>
    );
  }
  return (
    <>
      <Output text={prettyInput(call.input)} label={t('参数')} testId="tool-input" />
      <Output text={call.output} label={t('输出')} error={err} />
      {!call.input && !call.output && <div className={styles.empty}>{t('（无详情）')}</div>}
    </>
  );
};

const EditStats: React.FC<{ call: ToolCall }> = ({ call }) => {
  const s = diffStats(call);
  if (!s || (s.added === 0 && s.removed === 0)) return null;
  return (
    <>
      <span className={styles.add}>+{s.added}</span>
      <span className={styles.del}>−{s.removed}</span>
    </>
  );
};

const CallLabel: React.FC<{ call: ToolCall }> = ({ call }) => {
  const d = describeCall(call);
  return (
    <>
      <span className={styles.verb}>{d.verb}</span>
      {d.target && (
        <span className={styles.target} title={d.target}>
          {d.target}
        </span>
      )}
    </>
  );
};

const ToolCallRowInner: React.FC<{ call: ToolCall }> = ({ call }) => {
  const kind = describeCall(call).kind;
  // 单个编辑默认展开：直接看到改了什么
  const diffOpen = (kind === 'edit' || kind === 'write') && diffsOf(call).length > 0;
  return (
    <Disclosure
      icon={KIND_ICON[kind]}
      label={<CallLabel call={call} />}
      meta={kind === 'edit' || kind === 'write' ? <EditStats call={call} /> : undefined}
      status={call.status}
      duration={callDuration(call)}
      defaultOpen={diffOpen}
      testId="tool-row"
      attrs={{ 'data-kind': kind, 'data-tool': call.name }}
    >
      <CallBody call={call} />
    </Disclosure>
  );
};

/** reduceTrace 每次都会生成新的 ToolCall 对象：按内容比较，已结束的行不随流式更新重渲染 */
export function sameCall(a: ToolCall, b: ToolCall): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.name === b.name &&
      a.status === b.status &&
      a.input === b.input &&
      a.output === b.output &&
      a.startedAt === b.startedAt &&
      a.endedAt === b.endedAt)
  );
}

export const ToolCallRow = memo(ToolCallRowInner, (p, n) => sameCall(p.call, n.call));

const GroupSummaryMeta: React.FC<{ bucket: Bucket; calls: ToolCall[] }> = ({ bucket, calls }) => {
  const s = groupStats(calls);
  return (
    <>
      {bucket === 'edit' && (s.added > 0 || s.removed > 0) && (
        <>
          <span className={styles.add}>+{s.added}</span>
          <span className={styles.del}>−{s.removed}</span>
        </>
      )}
      {s.failed > 0 && <span className={styles.failedTag}>{t('{0} 项失败', s.failed)}</span>}
    </>
  );
};

const ToolGroupInner: React.FC<{ bucket: Bucket; calls: ToolCall[]; id: string }> = ({
  bucket,
  calls,
  id,
}) => {
  const status: CallStatus = calls.some((c) => c.status === 'running')
    ? 'running'
    : calls.some((c) => c.status === 'error')
      ? 'error'
      : 'done';
  return (
    <Disclosure
      icon={BUCKET_ICON[bucket]}
      label={<span className={styles.verb}>{groupTitle(bucket, calls)}</span>}
      meta={<GroupSummaryMeta bucket={bucket} calls={calls} />}
      status={status}
      duration={groupDuration(calls)}
      testId="tool-group"
      attrs={{ 'data-bucket': bucket, 'data-count': String(calls.length), 'data-group-id': id }}
      variant="group"
    >
      <div className={styles.groupList}>
        {calls.map((c) => (
          <ToolCallRow key={c.id} call={c} />
        ))}
      </div>
    </Disclosure>
  );
};

const ToolGroup = memo(
  ToolGroupInner,
  (p, n) =>
    p.id === n.id &&
    p.bucket === n.bucket &&
    p.calls.length === n.calls.length &&
    p.calls.every((c, i) => sameCall(c, n.calls[i]!)),
);

const Subagent: React.FC<{ call: ToolCall; children: TimelineItem[] }> = ({ call, children }) => {
  const o = parseInput(call.input);
  const prompt = typeof o?.prompt === 'string' ? o.prompt : undefined;
  const d = describeCall(call);
  return (
    <Disclosure
      icon={Bot}
      label={
        <>
          <span className={styles.verb}>{d.verb}</span>
          {d.target && (
            <span className={styles.target} title={d.target}>
              {d.target}
            </span>
          )}
        </>
      }
      meta={
        children.length > 0 ? (
          <span className={styles.subCount}>{t('{0} 步', countCalls(children))}</span>
        ) : undefined
      }
      status={call.status}
      duration={callDuration(call)}
      testId="tool-subagent"
      attrs={{ 'data-tool': call.name }}
      variant="block"
    >
      {prompt && <div className={styles.subPrompt}>{prompt}</div>}
      {children.length > 0 && <ToolTimeline items={children} nested />}
      {call.output && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>{t('结果')}</div>
          <div className={styles.subResult} data-testid="tool-output">
            <Markdown text={call.output} />
          </div>
        </div>
      )}
    </Disclosure>
  );
};

function countCalls(items: TimelineItem[]): number {
  return items.reduce((n, it) => {
    if (it.type === 'call') return n + 1;
    if (it.type === 'group') return n + it.calls.length;
    if (it.type === 'subagent') return n + 1 + countCalls(it.children);
    return n;
  }, 0);
}

/** 思考中的已用时（只在运行时挂载，随之清理定时器） */
const ThinkingTimer: React.FC<{ startedAt?: number }> = ({ startedAt }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!startedAt) return null;
  return (
    <span data-testid="tool-thinking-timer">
      {' '}
      · {Math.max(0, Math.floor((now - startedAt) / 1000))}s
    </span>
  );
};

const Thinking = memo(function Thinking({
  text,
  running,
  startedAt,
  endedAt,
}: {
  text: string;
  running: boolean;
  startedAt?: number;
  endedAt?: number;
}) {
  // 流式时默认展开；结束后自动折叠。用户手动切换过就尊重用户
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const open = manual ?? running;
  const ms = startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined;
  return (
    <Disclosure
      icon={Brain}
      label={
        <span className={styles.verb}>
          {running ? (
            <>
              {t('思考中')}
              <ThinkingTimer startedAt={startedAt} />
            </>
          ) : (
            thoughtLabel(ms)
          )}
        </span>
      }
      status={running ? 'running' : 'done'}
      open={open}
      onOpenChange={setManual}
      testId="tool-thinking"
    >
      <div className={styles.thinkText}>{text}</div>
    </Disclosure>
  );
});

/** 顶层时间线一次最多渲染的条目数；更早的折叠成一行，点击展开（长任务不会一次渲染上千行） */
export const TIMELINE_WINDOW = 60;

export const ToolTimeline: React.FC<{ items: TimelineItem[]; nested?: boolean }> = ({
  items,
  nested,
}) => {
  const [showAll, setShowAll] = useState(false);
  if (!items.length) return null;
  const hidden =
    !nested && !showAll && items.length > TIMELINE_WINDOW ? items.length - TIMELINE_WINDOW : 0;
  const visible = hidden ? items.slice(hidden) : items;
  return (
    <div
      className={`${styles.timeline} ${nested ? styles.nested : ''}`}
      data-testid={nested ? undefined : 'tool-timeline'}
    >
      {hidden > 0 && (
        <button
          type="button"
          className={styles.earlier}
          data-testid="tool-show-earlier"
          onClick={() => setShowAll(true)}
        >
          <Icon icon={ChevronsUp} size={13} />
          {t('显示更早的 {0} 步', hidden)}
        </button>
      )}
      {visible.map((it) => {
        switch (it.type) {
          case 'thinking':
            return (
              <Thinking
                key={it.id}
                text={it.text}
                running={it.running}
                startedAt={it.startedAt}
                endedAt={it.endedAt}
              />
            );
          case 'call':
            return <ToolCallRow key={it.call.id} call={it.call} />;
          case 'group':
            return <ToolGroup key={it.id} id={it.id} bucket={it.bucket} calls={it.calls} />;
          default:
            return (
              <Subagent key={it.call.id} call={it.call}>
                {it.children}
              </Subagent>
            );
        }
      })}
    </div>
  );
};
