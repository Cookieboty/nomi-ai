/**
 * 新标签页：搜索文件或输入网址，并用磁贴打开浏览器 / 文件 / 变更 / 侧边会话。
 */
import { Icon, t } from '@nomi-ai/ui';
import {
  IconFileText as FileText,
  IconGitCompare as GitCompareArrows,
  IconWorld as Globe,
  IconMessageCirclePlus as MessageCirclePlus,
  IconSearch as Search,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';

import { harnessClient, type WorkspaceTreeNode } from '../../services/harnessClient';
import { rankItems } from '../../utils/fuzzy';
import { workspaceFileHref } from '../../utils/resourceLinks';
import { parseBrowserUrl } from '../../utils/sideTabs';

import styles from './WorkspacePages.module.css';

export interface FileHit {
  name: string;
  path: string;
  root: string;
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
  onOpenChanges: () => void;
  onOpenFiles: () => void;
  onOpenSideChat: () => void;
  onOpenBrowser: (url: string) => void;
  onOpenFile: (href: string, root: string) => void;
}> = ({
  tabKey,
  hidden,
  cwd,
  roots,
  onOpenChanges,
  onOpenFiles,
  onOpenSideChat,
  onOpenBrowser,
  onOpenFile,
}) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<FileHit[]>([]);
  const folders = useMemo(
    () => (roots?.length ? [...roots] : cwd ? [cwd] : []).filter(Boolean),
    [roots, cwd],
  );

  useEffect(() => {
    if (hidden || !folders.length) return;
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
      if (!cancelled) setFiles(hits);
    })();
    return () => {
      cancelled = true;
    };
  }, [hidden, folders]);

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
      onOpenBrowser(url);
      return;
    }
    const hit = hits[index];
    if (hit) onOpenFile(workspaceFileHref(hit.root, hit.path), hit.root);
  };

  return (
    <div className={styles.page} hidden={hidden} data-testid="new-tab-page" data-tab-key={tabKey}>
      <div className={styles.hero}>
        <div className={styles.heroInner}>
          <form
            className={styles.searchWrap}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Icon icon={Search} size={16} className={styles.searchIcon} />
            <input
              className={styles.search}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
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
              autoFocus={!hidden}
            />
            {hits.length > 0 && (
              <ul className={styles.suggest} role="listbox" data-testid="new-tab-file-hits">
                {hits.map((hit, i) => (
                  <li key={`${hit.root}:${hit.path}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      data-active={i === active || undefined}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => submit(i)}
                    >
                      <Icon icon={FileText} size={14} />
                      <span>{hit.name}</span>
                      <span className={styles.suggestPath}>{hit.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </form>
          <div>
            <p className={styles.sectionLabel}>{t('ui.session-workspace.new-tab-section')}</p>
            <div className={styles.tiles}>
              <button
                type="button"
                className={styles.tile}
                data-testid="new-tab-open-browser"
                onClick={() => onOpenBrowser('')}
              >
                <Icon icon={Globe} size={20} />
                <span className={styles.tileLabel}>{t('ui.session-workspace.open-browser')}</span>
              </button>
              <button
                type="button"
                className={styles.tile}
                data-testid="new-tab-open-files"
                disabled={!cwd}
                onClick={onOpenFiles}
              >
                <Icon icon={FileText} size={20} />
                <span className={styles.tileLabel}>{t('ui.knowledge-local.files')}</span>
              </button>
              <button
                type="button"
                className={styles.tile}
                data-testid="new-tab-open-changes"
                disabled={!cwd}
                onClick={onOpenChanges}
              >
                <Icon icon={GitCompareArrows} size={20} />
                <span className={styles.tileLabel}>{t('ui.session-workspace.changed')}</span>
              </button>
              <button
                type="button"
                className={styles.tile}
                data-testid="new-tab-open-side-chat"
                onClick={onOpenSideChat}
              >
                <Icon icon={MessageCirclePlus} size={20} />
                <span className={styles.tileLabel}>{t('ui.session-workspace.open-side-chat')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
