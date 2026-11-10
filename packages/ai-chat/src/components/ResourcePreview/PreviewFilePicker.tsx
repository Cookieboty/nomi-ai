import { Icon, t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, File, Folder, Search } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ResourceContextValue, ResourceScope } from '../../contexts/ResourceContext';
import {
  resourcePreviewClient,
  type PreviewDirectoryEntry,
  type PreviewDirectoryResult,
} from '../../services/resourcePreviewClient';
import { workspaceFileHref } from '../../utils/resourceLinks';

import styles from './PreviewFilePicker.module.css';
import { previewPathCrumbs } from './previewPath';

/** Shared absolute-path navigation for every file renderer. Browsing grants no file writes. */
export function PreviewFilePicker({
  path,
  url,
  scope,
  onOpen,
}: {
  path: string;
  url?: string;
  scope: ResourceScope;
  onOpen: ResourceContextValue['open'];
}) {
  const [directory, setDirectory] = useState<string | null>(null);
  const [activeCrumb, setActiveCrumb] = useState(-1);
  const [cache, setCache] = useState<Record<string, PreviewDirectoryResult>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const breadcrumb = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const open = directory !== null;
  const local = /^(?:\/|[A-Za-z]:[\\/])/.test(path);
  const current = path.replace(/\\/g, '/');
  const crumbs = useMemo(() => (local ? previewPathCrumbs(path) : []), [path, local]);
  const key = (path: string) => `${url ?? ''}\u0000${path}`;
  const state = directory === null ? undefined : cache[key(directory)];
  const load = useCallback(
    async (directory: string) => {
      if (!url) return;
      let result: PreviewDirectoryResult;
      try {
        result = await resourcePreviewClient.listDirectory(url, directory);
      } catch {
        result = { ok: false, code: 'read' };
      }
      setCache((old) => ({ ...old, [`${url}\u0000${directory}`]: result }));
    },
    [url],
  );
  const close = (focus = false) => {
    setDirectory(null);
    if (focus) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const element = breadcrumb.current;
    if (!element) return;
    const revealFile = () => {
      element.scrollLeft = element.scrollWidth;
    };
    revealFile();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(revealFile);
    observer.observe(element);
    return () => observer.disconnect();
  }, [path]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setDirectory(null);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [open, directory]);
  const tree = (
    nodes: PreviewDirectoryEntry[],
    depth = 0,
    ancestors = new Set(directory ? [directory] : []),
  ): React.ReactNode => {
    const filtered = nodes.filter(
      (node) =>
        !query.trim() || node.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
    return filtered.map((node) => {
      const folder = node.kind === 'dir';
      const children = cache[key(node.path)];
      const cyclic = folder && ancestors.has(node.path);
      const showChildren = folder && !cyclic && expanded.has(node.path);
      return (
        <li key={`${node.path}\u0000${node.name}`} role="none">
          <button
            type="button"
            disabled={cyclic}
            role="treeitem"
            title={node.path}
            aria-expanded={folder ? showChildren : undefined}
            aria-selected={!folder && node.path.replace(/\\/g, '/') === current}
            aria-level={depth + 1}
            className={styles.node}
            data-preview-picker-control
            style={{ paddingInlineStart: `calc(var(--cd-space-2) + ${depth} * var(--cd-space-3))` }}
            onClick={() => {
              if (folder) {
                setExpanded((old) => {
                  const next = new Set(old);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                });
                if (!showChildren) void load(node.path);
              } else {
                close(true);
                if (node.path.replace(/\\/g, '/') !== current)
                  onOpen(workspaceFileHref('', node.path), { ...scope });
              }
            }}
            onKeyDown={(event) => {
              if (folder && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
                event.preventDefault();
                setExpanded((old) => {
                  const next = new Set(old);
                  if (event.key === 'ArrowRight') next.add(node.path);
                  else next.delete(node.path);
                  return next;
                });
                if (event.key === 'ArrowRight' && !children?.ok) void load(node.path);
              }
            }}
          >
            {folder && <Icon icon={showChildren ? ChevronDown : ChevronRight} size={12} />}
            <Icon icon={folder ? Folder : File} size={14} />
            <span>{node.name}</span>
          </button>
          {showChildren && (
            <ul role="group">
              {!children ? (
                <li role="status">{t('ui.session-workspace.preview-files-loading')}</li>
              ) : !children.ok ? (
                <li role="status">{t('ui.session-workspace.preview-files-error')}</li>
              ) : (
                tree(children.entries ?? [], depth + 1, new Set([...ancestors, node.path]))
              )}
            </ul>
          )}
        </li>
      );
    });
  };
  const entries = state?.entries ?? [];
  const hasMatches = entries.some((node) =>
    node.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div
      ref={root}
      className={styles.picker}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
        if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          if (event.target === search.current && event.key !== 'ArrowDown') return;
          const items = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]:not(:disabled)') ??
              [],
          );
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : Math.max(
                    0,
                    Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                  );
          if (items[next]) {
            event.preventDefault();
            items[next].focus();
          }
        }
      }}
    >
      {local ? (
        <nav
          ref={breadcrumb}
          className={styles.path}
          aria-label={t('ui.session-workspace.file-path')}
          title={path}
        >
          {crumbs.map((crumb, index) => {
            const file = index === crumbs.length - 1;
            return (
              <React.Fragment key={crumb.path}>
                {index > 0 && <Icon icon={ChevronRight} size={12} />}
                <button
                  data-preview-picker-control
                  type="button"
                  disabled={!url}
                  className={`${styles.crumb} ${file ? styles.filename : styles.directory}`}
                  title={crumb.path}
                  aria-current={file ? 'page' : undefined}
                  aria-haspopup="dialog"
                  aria-expanded={open && activeCrumb === index}
                  data-testid={file ? 'preview-file-picker' : undefined}
                  onClick={(event) => {
                    if (open && trigger.current === event.currentTarget) {
                      close();
                      return;
                    }
                    trigger.current = event.currentTarget;
                    setActiveCrumb(index);
                    setQuery('');
                    setExpanded(new Set());
                    setDirectory(crumb.directory);
                    void load(crumb.directory);
                    const anchor =
                      event.currentTarget.getBoundingClientRect().left -
                      (root.current?.getBoundingClientRect().left ?? 0);
                    root.current?.style.setProperty(
                      '--preview-picker-anchor',
                      `${Math.max(0, anchor)}px`,
                    );
                  }}
                >
                  <span>{crumb.name}</span>
                </button>
              </React.Fragment>
            );
          })}
        </nav>
      ) : (
        <span className={styles.url} title={path}>
          {path}
        </span>
      )}
      {open && (
        <div
          className={styles.popover}
          role="dialog"
          aria-label={t('ui.session-workspace.preview-choose-file')}
          data-testid="preview-file-menu"
        >
          <label className={styles.search}>
            <Icon icon={Search} size={14} />
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('ui.session-workspace.preview-find-file')}
              placeholder={t('ui.session-workspace.preview-find-file')}
            />
          </label>
          {!state && <p role="status">{t('ui.session-workspace.preview-files-loading')}</p>}
          {state && !state.ok && (
            <p role="status">{t('ui.session-workspace.preview-files-error')}</p>
          )}
          {state?.ok && !hasMatches && (
            <p role="status">{t('ui.session-workspace.preview-files-empty')}</p>
          )}
          {!!entries.length && (
            <ul role="tree" aria-label={t('ui.session-workspace.preview-files')}>
              {tree(entries)}
            </ul>
          )}
          {state?.truncated && (
            <p role="status">{t('ui.session-workspace.preview-directory-truncated')}</p>
          )}
        </div>
      )}
    </div>
  );
}
