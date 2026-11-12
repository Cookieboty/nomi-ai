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

/** A visual overlay only: never owns a conversation, stream, queue or task lifecycle. */
export function useResourcePreview(scope: ResourceScope) {
  const [imageEntry, setImageEntry] = useState<ResourceEntry | null>(null);
  const [{ entries, activeKey }, setTabs] = useState<PreviewTabsState>({
    entries: [],
    activeKey: '',
  });
  const setActiveKey = useCallback(
    (key: string) => setTabs((old) => ({ ...old, activeKey: key })),
    [],
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
      if (!isOpen) {
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
      setTabs((old) =>
        openPreviewTab(
          old,
          { key, href, scope: { ...origin }, image: image ? { ...image } : undefined, navigation },
          protectedPreviewKeys(old.entries),
        ),
      );
    },
    [isOpen, resetLayout],
  );
  const scopeId = scope.id;
  const scopeCwd = scope.cwd;
  const scopeSource = scope.source;
  /** 文件的 Diff 是普通标签：和文件标签同一排、同一套关闭与右键菜单；同一文件的 Diff 与文件本身是两个标签 */
  const openDiff = useCallback(
    (diff: DiffTabSpec) => {
      if (!isOpen) {
        resetLayout();
        setConnected(null);
      }
      const key = diffEntryKey(diff);
      setTabs((old) =>
        openPreviewTab(
          withDiff(old, key, diff),
          {
            key,
            href: diff.path,
            scope: { id: scopeId, cwd: scopeCwd, source: scopeSource },
            diff: { ...diff },
          },
          protectedPreviewKeys(old.entries),
        ),
      );
    },
    [isOpen, resetLayout, scopeId, scopeCwd, scopeSource],
  );
  const updateDiff = useCallback(
    (diff: DiffTabSpec) => setTabs((old) => withDiff(old, diffEntryKey(diff), diff)),
    [],
  );
  const closeEntries = useCallback((keys: string[]) => {
    setTabs((old) => removePreviewTabs(old, keys));
    setConnected((old) => (old && keys.includes(old.key) ? null : old));
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
  const mismatch = !!active && (active.scope.id !== scope.id || active.scope.cwd !== scope.cwd);
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
      (connected?.scope.cwd ?? null) === (scope.cwd ?? null)
    );
  const value = useMemo(
    () => ({
      scope: { id: scopeId, cwd: scopeCwd, source: scopeSource },
      open,
      openDiff,
      updateDiff,
    }),
    [scopeId, scopeCwd, scopeSource, open, openDiff, updateDiff],
  );
  return {
    value,
    isOpen,
    mismatch,
    sendMismatch,
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
              mismatch={imageEntry.scope.id !== scope.id || imageEntry.scope.cwd !== scope.cwd}
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
