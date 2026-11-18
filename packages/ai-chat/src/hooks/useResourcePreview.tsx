import { t } from '@nomi-ai/ui';
import React, {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { getPreviewEdits } from '../components/ResourcePreview/previewEdits';
import {
  openPreviewTab,
  removePreviewTabs,
  type PreviewTabsState,
} from '../components/ResourcePreview/previewTabs';
import type { PreviewTabsControl } from '../components/ResourcePreview/ResourcePreview';
import { dirtyReviewDrafts } from '../components/SessionWorkspace/reviewDrafts';
import type {
  DiffTabSpec,
  ResourceScope,
  ResourceImageInfo,
  ResourceEntry,
} from '../contexts/ResourceContext';
import { isExternalResource, openExternalResource } from '../services/externalResource';
import { resourceTarget, resolveDocumentPath } from '../utils/resourceLinks';

import styles from './ResourcePreviewHost.module.css';
import { useResourcePreviewLayout } from './useResourcePreviewLayout';

/** 超过标签上限时不能淘汰的：有草稿 / 在保存 / 保存失败的文件标签，有没保存编辑的 Diff 标签 */
function protectedPreviewKeys(entries: readonly { key: string }[]): Set<string> {
  const keys = entries.map((entry) => entry.key);
  return new Set([
    ...getPreviewEdits(keys)
      .filter(({ session }) => session.state.dirty || session.state.saving || session.state.error)
      .map(({ key }) => key),
    ...dirtyReviewDrafts(keys),
  ]);
}

const LazyImage = lazy(() =>
  import('../components/ImageLightbox/ResourceImageModal').then((m) => ({
    default: m.ResourceImageModal,
  })),
);
const imageResource = (href: string, image?: ResourceImageInfo) => {
  // Provenance chooses the image viewer, never the resource type: ordinary
  // assistant/user links can point to documents, source files or websites.
  if (image?.kind === 'image') return true;
  const target = resourceTarget(href);
  if (!target || target.web) return false;
  if (!target.path) return true;
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(target.path);
};
const LazyPreview = lazy(() =>
  import('../components/ResourcePreview/ResourcePreview').then((m) => ({
    default: m.ResourcePreview,
  })),
);
const diffEntryKey = (diff: DiffTabSpec) => `diff\u0000${diff.key}`;
/** 已开着的 Diff 标签换成最新的改动；没开着原样返回（不触发重渲染） */
function withDiff(state: PreviewTabsState, key: string, diff: DiffTabSpec): PreviewTabsState {
  if (!state.entries.some((entry) => entry.key === key)) return state;
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.key === key ? { ...entry, href: diff.path, diff: { ...diff } } : entry,
    ),
  };
}

/**
 * 输入框被预览挡着（预览属于别的会话 / 工作区）时的说明：两种文案按 previewId 与 scopeId 是否相同选
 * （同一个会话换了工作区 / 别的会话）。没有这个说明时输入框不能是禁用的（用户看不出原因）。
 */
export interface SendBlockedReason {
  /** 当前会话键（预览按它分桶） */
  scopeId: string;
  /** 挡着输入框的那个预览属于哪个会话 */
  previewId: string;
}

/** 在工作区页里怎么画预览；文件 tabs 由 ResourcePreview 自己绘制。 */
export interface EmbeddedPreviewProps {
  inactive: boolean;
  expanded: boolean;
  onExpanded: (expanded: boolean) => void;
  controlRef: React.MutableRefObject<PreviewTabsControl | null>;
  /** 打开文件页内部显示 ResourcePreview 自己的文件 tabs。 */
  showTabs?: boolean;
  /** 只显示普通文件或 Diff，避免两个页面共用一排内部 tabs。 */
  mode?: 'files' | 'diffs' | 'all';
  /** 右侧工作区文件目录栏是否展开 */
  treeOpen?: boolean;
  /** 切换显示 / 隐藏右侧工作区文件目录栏 */
  onToggleTree?: () => void;
}

const EMPTY_PREVIEW_TABS: PreviewTabsState = { entries: [], activeKey: '' };
const SINGLE_BUCKET = '__single__';

/**
 * A visual overlay only: never owns a conversation, stream, queue or task lifecycle.
 * onShow：真的开了 / 切到一个文件或 Diff 时通知（工作区据此打开文件页）。
 * scoped：按会话 scope.id 独立隔离打开的文件与 Diff 预览列表，切换会话自动跟随切换。
 */
export function useResourcePreview(
  scope: ResourceScope,
  opts?: { onShow?: (kind: 'file' | 'diff') => void; scoped?: boolean },
) {
  const scoped = !!opts?.scoped;
  const scopeId = scope.id;
  const activeBucket = scoped ? scopeId : SINGLE_BUCKET;
  const onShowRef = useRef(opts?.onShow);
  useLayoutEffect(() => {
    onShowRef.current = opts?.onShow;
  });
  const [imageEntry, setImageEntry] = useState<ResourceEntry | null>(null);
  const [tabsByBucket, setTabsByBucket] = useState<Record<string, PreviewTabsState>>({});
  const currentTabs = tabsByBucket[activeBucket] ?? EMPTY_PREVIEW_TABS;
  const { entries, activeKey } = currentTabs;
  const updateBucket = useCallback(
    (bucket: string, updater: (old: PreviewTabsState) => PreviewTabsState) => {
      setTabsByBucket((all) => {
        const prev = all[bucket] ?? EMPTY_PREVIEW_TABS;
        const next = updater(prev);
        if (next === prev) return all;
        if (next.entries.length === 0 && !next.activeKey) {
          if (!(bucket in all)) return all;
          const rest = { ...all };
          delete rest[bucket];
          return rest;
        }
        return { ...all, [bucket]: next };
      });
    },
    [],
  );
  const setActiveKey = useCallback(
    (key: string) => updateBucket(activeBucket, (old) => ({ ...old, activeKey: key })),
    [activeBucket, updateBucket],
  );
  const navigationSequence = useRef(0);
  const [externalError, setExternalError] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const [connected, setConnected] = useState<{ key: string; scope: ResourceScope } | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  const isOpen = entries.length > 0;
  const layout = useResourcePreviewLayout(isOpen);
  const resetLayout = layout.reset;
  const open = useCallback(
    (href: string, origin: ResourceScope, image?: ResourceImageInfo) => {
      if (imageResource(href, image)) {
        setImageEntry({
          key: `${origin.id}\u0000${href}\u0000${image?.origin ?? 'document'}`,
          href,
          scope: { ...origin },
          image: image ?? { origin: 'document', kind: 'image' },
        });
        return;
      }
      if (isExternalResource(href, image)) {
        setExternalError(false);
        void openExternalResource(origin.cwd ?? '', href).then(
          (result) => {
            if (!result.ok && result.code !== 'cancelled') setExternalError(true);
          },
          () => setExternalError(true),
        );
        return;
      }
      const targetBucket = scoped ? origin.id || scopeId : SINGLE_BUCKET;
      if (!isOpen && targetBucket === activeBucket) {
        resetLayout();
        setConnected(null);
      }
      const target = resourceTarget(href);
      const identity = target?.path
        ? `${resolveDocumentPath(origin.cwd ?? '', target.path)}\u0000${target.line ?? ''}\u0000${target.lineEnd ?? ''}`
        : href;
      // Document links and file-tree clicks share an entry; images never enter this list.
      const document = /\.(?:md|markdown|mdx|txt|json)$/i.test(target?.path ?? '');
      const key = `${origin.id}\u0000${origin.cwd ?? ''}\u0000${identity}\u0000${document ? 'resource' : (image?.origin ?? 'resource')}`;
      const navigation =
        target?.fragment !== undefined
          ? { fragment: target.fragment, sequence: ++navigationSequence.current }
          : undefined;
      updateBucket(targetBucket, (old) =>
        openPreviewTab(
          old,
          { key, href, scope: { ...origin }, image: image ? { ...image } : undefined, navigation },
          protectedPreviewKeys(old.entries),
        ),
      );
      if (!scoped || targetBucket === scopeId) {
        onShowRef.current?.('file');
      }
    },
    [scoped, scopeId, activeBucket, isOpen, resetLayout, updateBucket],
  );
  const scopeCwd = scope.cwd;
  const scopeSource = scope.source;
  const scopeFallbacksKey = scope.fallbackCwds?.join('\0') ?? '';
  const scopeFallbacks = useMemo(
    () => (scopeFallbacksKey ? scopeFallbacksKey.split('\0') : undefined),
    [scopeFallbacksKey],
  );
  /** 文件的 Diff 是普通标签：和文件标签同一排、同一套关闭与右键菜单；同一文件的 Diff 与文件本身是两个标签 */
  const openDiff = useCallback(
    (diff: DiffTabSpec) => {
      if (!isOpen) {
        resetLayout();
        setConnected(null);
      }
      const key = diffEntryKey(diff);
      updateBucket(activeBucket, (old) =>
        openPreviewTab(
          withDiff(old, key, diff),
          {
            key,
            href: diff.path,
            scope: {
              id: scopeId,
              cwd: scopeCwd,
              source: scopeSource,
              fallbackCwds: scopeFallbacks,
            },
            diff: { ...diff },
          },
          protectedPreviewKeys(old.entries),
        ),
      );
      onShowRef.current?.('diff');
    },
    [
      isOpen,
      resetLayout,
      activeBucket,
      updateBucket,
      scopeId,
      scopeCwd,
      scopeSource,
      scopeFallbacks,
    ],
  );
  const updateDiff = useCallback(
    (diff: DiffTabSpec) =>
      updateBucket(activeBucket, (old) => withDiff(old, diffEntryKey(diff), diff)),
    [activeBucket, updateBucket],
  );
  const closeEntries = useCallback(
    (keys: string[]) => {
      if (keys.length === 0) return;
      setTabsByBucket((all) => {
        if (!scoped) {
          const prev = all[SINGLE_BUCKET] ?? EMPTY_PREVIEW_TABS;
          const next = removePreviewTabs(prev, keys);
          if (next === prev) return all;
          return next.entries.length === 0 ? {} : { [SINGLE_BUCKET]: next };
        }
        let changed = false;
        const out: Record<string, PreviewTabsState> = {};
        for (const [bucket, state] of Object.entries(all)) {
          const next =
            bucket === activeBucket || state.entries.some((e) => keys.includes(e.key))
              ? removePreviewTabs(state, keys)
              : state;
          if (next !== state) changed = true;
          if (next.entries.length > 0) out[bucket] = next;
        }
        return changed ? out : all;
      });
      setConnected((old) => (old && keys.includes(old.key) ? null : old));
    },
    [scoped, activeBucket],
  );
  /** agent 新标签拿到 cliSessionId 后，把已打开的文件 / Diff 预览从临时标签键平滑迁移到稳定会话键 */
  const migrateScope = useCallback((fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;
    setTabsByBucket((all) => {
      const fromState = all[fromId];
      if (!fromState || fromState.entries.length === 0) return all;
      const migratedEntries = fromState.entries.map((entry) =>
        entry.scope.id === fromId ? { ...entry, scope: { ...entry.scope, id: toId } } : entry,
      );
      const existing = all[toId];
      const existingKeys = new Set(existing?.entries.map((e) => e.key) ?? []);
      const mergedEntries = existing
        ? [...migratedEntries.filter((e) => !existingKeys.has(e.key)), ...existing.entries]
        : migratedEntries;
      const mergedActiveKey = existing?.activeKey || fromState.activeKey;
      const rest = { ...all };
      delete rest[fromId];
      return {
        ...rest,
        [toId]: { entries: mergedEntries, activeKey: mergedActiveKey },
      };
    });
    setImageEntry((cur) =>
      cur && cur.scope.id === fromId ? { ...cur, scope: { ...cur.scope, id: toId } } : cur,
    );
  }, []);
  const closeEntry = useCallback((key: string) => closeEntries([key]), [closeEntries]);
  useLayoutEffect(() => {
    if (!isOpen || !composerRef.current) return;
    const el = composerRef.current;
    const measure = () => setComposerHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isOpen, layout.expanded]);
  const active = entries.find((e) => e.key === activeKey) ?? entries[entries.length - 1];
  // 预览和当前会话对不上 = 属于别的会话，或同一个会话换了工作目录。两种「还没对上」不算：
  // - 会话标识还没定下来（没有会话 / 新建会话的同一帧里 id 还是空）；
  // - 预览是在工作目录解析出来之前打开的（刚新建 / 刚换项目，内核还没回 cwd）：它就属于这个会话，
  //   跟着会话走，不能因为 cwd 后到就把新会话的输入框禁掉。
  const scopeSettled = !!scopeId;
  const entryMismatch = (e: ResourceEntry) =>
    scopeSettled &&
    (e.scope.id !== scopeId || (e.scope.cwd != null && e.scope.cwd !== (scopeCwd ?? null)));
  const mismatch = !!active && entryMismatch(active);
  const connectConversation = useCallback(
    (next: ResourceScope) => {
      if (active) setConnected({ key: active.key, scope: { ...next } });
    },
    [active],
  );
  const sendMismatch =
    mismatch &&
    !(
      connected?.key === active?.key &&
      connected?.scope.id === scope.id &&
      (connected?.scope.cwd ?? null) === (scopeCwd ?? null)
    );
  /** 输入框被预览挡着不能发时的说明（同一个判断，预览提示与输入框上方共用） */
  const sendBlocked: SendBlockedReason | undefined = sendMismatch
    ? { scopeId, previewId: active?.scope.id ?? '' }
    : undefined;
  const value = useMemo(
    () => ({
      scope: {
        id: scopeId,
        cwd: scopeCwd,
        source: scopeSource,
        ...(scopeFallbacks ? { fallbackCwds: scopeFallbacks } : {}),
      },
      open,
      openDiff,
      updateDiff,
    }),
    [scopeId, scopeCwd, scopeSource, scopeFallbacks, open, openDiff, updateDiff],
  );
  const visibleImageEntry =
    imageEntry && (!scoped || imageEntry.scope.id === scope.id) ? imageEntry : null;
  const overlays = (
    <>
      {visibleImageEntry && (
        <Suspense fallback={null}>
          <LazyImage
            key={visibleImageEntry.key}
            entry={visibleImageEntry}
            mismatch={entryMismatch(visibleImageEntry)}
            onClose={() => setImageEntry(null)}
          />
        </Suspense>
      )}
      {externalError && (
        <div className={styles.externalError} role="alert">
          <span>{t('ui.session-workspace.preview-external-error')}</span>
          <button type="button" onClick={() => setExternalError(false)}>
            {t('ui.providers-schedule.close')}
          </button>
        </div>
      )}
    </>
  );
  /** 标签区里的预览：标签栏在外面，铺满由标签区管 */
  const renderEmbedded = (p: EmbeddedPreviewProps) => {
    const mode = p.mode ?? 'all';
    const visibleEntries =
      mode === 'files'
        ? entries.filter((entry) => !entry.diff)
        : mode === 'diffs'
          ? entries.filter((entry) => !!entry.diff)
          : entries;
    if (!visibleEntries.length) return null;
    const visibleActiveKey = visibleEntries.some((entry) => entry.key === activeKey)
      ? activeKey
      : visibleEntries[visibleEntries.length - 1]!.key;
    return isOpen ? (
      <Suspense fallback={null}>
        <LazyPreview
          entries={visibleEntries}
          activeKey={visibleActiveKey}
          expanded={p.expanded}
          originMismatch={mismatch}
          conversationConnected={mismatch && !sendMismatch}
          onActive={setActiveKey}
          onCloseEntry={closeEntry}
          onCloseEntries={closeEntries}
          onExpanded={p.onExpanded}
          onOpen={open}
          hideTabs={!p.showTabs}
          embedded
          inactive={p.inactive}
          controlRef={p.controlRef}
          treeOpen={p.treeOpen}
          onToggleTree={p.onToggleTree}
        />
      </Suspense>
    ) : null;
  };
  return {
    value,
    isOpen,
    entries,
    activeKey: active?.key ?? '',
    setActiveKey,
    closeEntries,
    migrateScope,
    overlays,
    renderEmbedded,
    mismatch,
    sendMismatch,
    sendBlocked,
    connectConversation,
    workspaceCwd: active?.scope.cwd,
    composerRef,
    expanded: layout.expanded,
    className: isOpen
      ? `main-content--resource-preview${layout.expanded ? ' main-content--resource-expanded' : ''}`
      : '',
    style: isOpen
      ? ({
          ...layout.style,
          '--resource-composer-height': `${composerHeight}px`,
        } as React.CSSProperties)
      : undefined,
    panel: (
      <>
        {imageEntry && (
          <Suspense fallback={null}>
            <LazyImage
              key={imageEntry.key}
              entry={imageEntry}
              mismatch={entryMismatch(imageEntry)}
              onClose={() => setImageEntry(null)}
            />
          </Suspense>
        )}
        {externalError && (
          <div className={styles.externalError} role="alert">
            <span>{t('ui.session-workspace.preview-external-error')}</span>
            <button type="button" onClick={() => setExternalError(false)}>
              {t('ui.providers-schedule.close')}
            </button>
          </div>
        )}
        {isOpen && (
          <>
            {layout.splitter}
            <Suspense fallback={null}>
              <LazyPreview
                entries={entries}
                activeKey={activeKey}
                expanded={layout.expanded}
                originMismatch={mismatch}
                conversationConnected={mismatch && !sendMismatch}
                onActive={setActiveKey}
                onCloseEntry={closeEntry}
                onCloseEntries={closeEntries}
                onExpanded={layout.onExpanded}
                onOpen={open}
              />
            </Suspense>
          </>
        )}
      </>
    ),
  };
}
