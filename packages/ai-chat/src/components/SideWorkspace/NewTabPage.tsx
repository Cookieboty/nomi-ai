/**
 * 新标签页（方案 A：分组命令台 + 紧凑横向功能卡）：
 * 顶部上下文与统一搜索栏 + 按分组排列的横向功能卡（未来新模块可直接往 sections 注册）。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  IconFileText as FileText,
  IconFolder as Folder,
  IconGitCompare as GitCompareArrows,
  IconWorld as Globe,
  IconMessageCirclePlus as MessageCirclePlus,
  IconRoute as RouteIcon,
  IconSearch as Search,
  IconTerminal2 as TerminalIcon,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { harnessClient, type WorkspaceTreeNode } from '../../services/harnessClient';
import { clearFilePathDrag, resolveDragPath, startFilePathDrag } from '../../utils/filePathDrag';
import { rankItems } from '../../utils/fuzzy';
import { basename, workspaceFileHref } from '../../utils/resourceLinks';
import { parseBrowserUrl } from '../../utils/sideTabs';

import styles from './NewTabPage.module.css';

export interface FileHit {
  name: string;
  path: string;
  root: string;
}

interface NewTabAction {
  id: string;
  testId: string;
  icon: React.ComponentProps<typeof Icon>['icon'];
  label: string;
  description: string;
  tone?: 'accent' | 'neutral';
  badge?: number;
  disabled?: boolean;
  onClick: () => void;
}

interface NewTabSection {
  id: string;
  title: string;
  actions: readonly NewTabAction[];
}

const flatten = (
  nodes: readonly WorkspaceTreeNode[],
  out: { name: string; path: string }[] = [],
) => {
  for (const n of nodes) {
    if (n.kind === 'file') out.push({ name: n.name, path: n.path });
    if (n.children) flatten(n.children, out);
  }
  return out;
};

export const NewTabPage: React.FC<{
  tabKey: string;
  hidden?: boolean;
  cwd?: string | null;
  roots?: readonly string[] | null;
  projectPrimary?: string | null;
  changesCount?: number;
  hasSessionTrace?: boolean;
  onOpenChanges: () => void;
  onOpenFiles: () => void;
  onOpenSideChat: () => void;
  onOpenTrace?: () => void;
  onOpenBrowser: (url: string) => void;
  onOpenTerminal: () => void;
  onOpenFile: (href: string, root: string) => void;
}> = ({
  tabKey,
  hidden,
  cwd,
  roots,
  projectPrimary,
  changesCount,
  hasSessionTrace = false,
  onOpenChanges,
  onOpenFiles,
  onOpenSideChat,
  onOpenTrace,
  onOpenBrowser,
  onOpenTerminal,
  onOpenFile,
}) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [noMatch, setNoMatch] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cached = useRef<{ key: string; files: FileHit[] } | null>(null);
  const folders = useMemo(
    () => (roots?.length ? [...roots] : cwd ? [cwd] : []).filter(Boolean),
    [roots, cwd],
  );

  useEffect(() => {
    if (hidden || !folders.length) return;
    const key = folders.join('\0');
    if (cached.current?.key === key) {
      setFiles(cached.current.files);
      return;
    }
    let cancelled = false;
    void (async () => {
      const hits: FileHit[] = [];
      for (const root of folders) {
        const res = await harnessClient.workspaceList(root);
        if (cancelled) return;
        if (res.ok && res.entries) {
          for (const f of flatten(res.entries)) hits.push({ ...f, root });
        }
      }
      if (!cancelled) {
        cached.current = { key, files: hits };
        setFiles(hits);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hidden, folders]);

  useEffect(() => {
    if (!hidden) inputRef.current?.focus();
  }, [hidden]);

  const url = parseBrowserUrl(query);
  const hits = useMemo(() => {
    const q = query.trim();
    if (!q || url) return [];
    return rankItems(
      files,
      q,
      (f) => [
        { text: f.name, weight: 2 },
        { text: f.path, weight: 1 },
      ],
      8,
    ).map((r) => r.item);
  }, [files, query, url]);

  const submit = (index = active) => {
    if (url) {
      setNoMatch(false);
      onOpenBrowser(url);
      return;
    }
    const hit = hits[index];
    if (hit) {
      setNoMatch(false);
      onOpenFile(workspaceFileHref(hit.root, hit.path), hit.root);
      return;
    }
    if (query.trim()) setNoMatch(true);
  };

  const displayRoot = (projectPrimary || cwd || '').trim();
  const rootName = displayRoot ? basename(displayRoot.replace(/[\\/]+$/, '')) || displayRoot : '';
  const hasWorkspace = Boolean(cwd);

  const sections: readonly NewTabSection[] = [
    {
      id: 'workspace',
      title: t('ui.session-workspace.new-tab-section-workspace'),
      actions: [
        {
          id: 'terminal',
          testId: 'new-tab-open-terminal',
          icon: TerminalIcon,
          label: t('ui.cli-monitor.fleet-origin-terminal'),
          description: t('ui.session-workspace.new-tab-desc-terminal'),
          tone: 'accent',
          onClick: onOpenTerminal,
        },
        {
          id: 'files',
          testId: 'new-tab-open-files',
          icon: FileText,
          label: t('ui.knowledge-local.files'),
          description: hasWorkspace
            ? t('ui.session-workspace.new-tab-desc-files')
            : t('ui.session-workspace.new-tab-need-workspace'),
          tone: 'accent',
          disabled: !hasWorkspace,
          onClick: onOpenFiles,
        },
        {
          id: 'changes',
          testId: 'new-tab-open-changes',
          icon: GitCompareArrows,
          label: t('ui.session-workspace.changed'),
          description: hasWorkspace
            ? t('ui.session-workspace.new-tab-desc-changes')
            : t('ui.session-workspace.new-tab-need-workspace'),
          tone: 'accent',
          badge: changesCount && changesCount > 0 ? changesCount : undefined,
          disabled: !hasWorkspace,
          onClick: onOpenChanges,
        },
      ],
    },
    {
      id: 'tools',
      title: t('ui.session-workspace.new-tab-section-tools'),
      actions: [
        {
          id: 'browser',
          testId: 'new-tab-open-browser',
          icon: Globe,
          label: t('ui.session-workspace.open-browser'),
          description: t('ui.session-workspace.new-tab-desc-browser'),
          tone: 'neutral',
          onClick: () => onOpenBrowser(''),
        },
        {
          id: 'side-chat',
          testId: 'new-tab-open-side-chat',
          icon: MessageCirclePlus,
          label: t('ui.session-workspace.open-side-chat'),
          description: t('ui.session-workspace.new-tab-desc-side-chat'),
          tone: 'neutral',
          onClick: onOpenSideChat,
        },
        ...(onOpenTrace
          ? [
              {
                id: 'trace',
                testId: 'new-tab-open-trace',
                icon: RouteIcon,
                label: t('ui.devtools.session-trace'),
                description: t('ui.session-workspace.new-tab-desc-trace'),
                tone: 'neutral' as const,
                disabled: !hasSessionTrace,
                onClick: onOpenTrace,
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className={styles.page} hidden={hidden} data-testid="new-tab-page" data-tab-key={tabKey}>
      <div className={styles.scroll}>
        <div className={styles.inner}>
          {displayRoot ? (
            <div className={styles.contextBar} data-testid="new-tab-context">
              <Icon icon={Folder} size={14} className={styles.contextIcon} />
              <span className={styles.contextName}>{rootName}</span>
              <span className={styles.contextPath} title={displayRoot}>
                {displayRoot}
              </span>
            </div>
          ) : null}

          <div>
            <form
              className={styles.searchWrap}
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Icon icon={Search} size={16} className={styles.searchIcon} />
              <input
                ref={inputRef}
                className={styles.search}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                  setNoMatch(false);
                }}
                onKeyDown={(e) => {
                  if (!hits.length) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((i) => (i + 1) % hits.length);
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((i) => (i - 1 + hits.length) % hits.length);
                  }
                }}
                placeholder={t('ui.session-workspace.new-tab-search')}
                aria-label={t('ui.session-workspace.new-tab-search')}
                data-testid="new-tab-search"
              />
              <kbd className={styles.searchHint} aria-hidden="true">
                ↵
              </kbd>
              {hits.length > 0 && (
                <ul className={styles.suggest} role="listbox" data-testid="new-tab-file-hits">
                  {hits.map((hit, i) => {
                    const dragPath = resolveDragPath(hit.path, hit.root);
                    return (
                      <li key={`${hit.root}:${hit.path}`}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === active}
                          data-active={i === active || undefined}
                          draggable={!!dragPath}
                          onDragStart={(e) => {
                            if (!dragPath) return;
                            startFilePathDrag(e.dataTransfer, { path: dragPath, kind: 'file' });
                          }}
                          onDragEnd={() => clearFilePathDrag()}
                          onMouseEnter={() => setActive(i)}
                          onClick={() => submit(i)}
                        >
                          <Icon icon={FileText} size={14} />
                          <span>{hit.name}</span>
                          <span className={styles.suggestPath}>{hit.path}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </form>
            {noMatch && (
              <p className={styles.emptyHint} role="status" data-testid="new-tab-no-match">
                {t('ui.foundation.no-matching-files')}
              </p>
            )}
          </div>

          <div className={styles.sections}>
            {sections.map((section) => {
              const titleId = `new-tab-sec-${tabKey}-${section.id}`;
              return (
                <section
                  key={section.id}
                  className={styles.section}
                  data-testid="new-tab-section"
                  data-section-id={section.id}
                  aria-labelledby={titleId}
                >
                  <h2 id={titleId} className={styles.sectionTitle}>
                    {section.title}
                  </h2>
                  <div className={styles.grid}>
                    {section.actions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className={styles.card}
                        data-testid={action.testId}
                        disabled={action.disabled}
                        onClick={action.onClick}
                      >
                        <span
                          className={styles.cardIcon}
                          data-tone={action.tone ?? 'accent'}
                          aria-hidden="true"
                        >
                          <Icon icon={action.icon} size={18} />
                        </span>
                        <span className={styles.cardBody}>
                          <span className={styles.cardHead}>
                            <span className={styles.cardTitle}>{action.label}</span>
                            {action.badge !== undefined && action.badge > 0 ? (
                              <span
                                className={styles.cardBadge}
                                data-testid={
                                  action.id === 'changes' ? 'new-tab-changes-badge' : undefined
                                }
                              >
                                {action.badge}
                              </span>
                            ) : null}
                          </span>
                          <span className={styles.cardDesc}>{action.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
