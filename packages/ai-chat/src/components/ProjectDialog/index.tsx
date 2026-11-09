/**
 * 创建 / 编辑项目：名称 + 源文件夹（第一个加进来的是主文件夹，可以改）。
 *
 * 主文件夹是会话的工作目录、相对路径的基准，git / worktree / AGENTS.md 以它为准；其余文件夹 Nomi 与
 * 编程助手同样能读写。文件夹由内核逐个校验（过宽的根、受保护目录、彼此嵌套都会被拒），出错时显示内核给的原因。
 * 移除项目只删记录，不碰磁盘上的文件。
 */
import { Button, Icon, Modal, t, useLocale } from '@nomi-ai/ui';
import { ChevronDown, Folder, FolderOpen, Plus, Star, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import { projectRoots, projectsClient, type Project } from '../../services/projects';
import { workspaceKey } from '../../utils/workspacePath';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';

export const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 「在此电脑上添加文件夹」：最近用过的目录 + 选择文件夹… */
const AddFolderMenu: React.FC<{
  exclude: readonly string[];
  onAdd: (dir: string) => void;
  variant: 'empty' | 'row';
}> = ({ exclude, onAdd, variant }) => {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void harnessClient
      .recentCwds()
      .then((l) => alive && setRecent(l))
      .catch(() => undefined);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 只收起菜单，不关整个弹窗
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      alive = false;
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const taken = new Set(exclude.map(workspaceKey));
  const shown = recent.filter((p) => !taken.has(workspaceKey(p)));
  const browse = async () => {
    setOpen(false);
    const picked = await harnessClient.pickDir().catch(() => null);
    if (picked) onAdd(picked);
  };

  const menu = open && (
    <div className={styles.menu} role="menu" data-testid="project-add-menu">
      {shown.length > 0 && <div className={styles.menuGroup}>{t('ui.cli-monitor.recent')}</div>}
      {shown.map((p) => (
        <button
          key={p}
          type="button"
          role="menuitem"
          className={styles.menuItem}
          title={p}
          data-testid="project-add-recent"
          onClick={() => {
            setOpen(false);
            onAdd(p);
          }}
        >
          <Icon icon={Folder} size={14} />
          <span className={styles.menuName}>{baseName(p)}</span>
          <span className={styles.menuPath}>{p}</span>
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className={styles.menuItem}
        data-testid="project-add-browse"
        onClick={() => void browse()}
      >
        <Icon icon={FolderOpen} size={14} />
        <span className={styles.menuName}>{t('ui.cli-monitor.choose-folder-ellipsis')}</span>
      </button>
    </div>
  );

  if (variant === 'row') {
    return (
      <div className={styles.addRowWrap} ref={ref}>
        <button
          type="button"
          className={styles.addRow}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid="project-add-folder"
        >
          <Icon icon={Plus} size={16} />
          {t('ui.cli-monitor.project-add-folder')}
        </button>
        {menu}
      </div>
    );
  }
  return (
    <div className={styles.empty} ref={ref}>
      <button
        type="button"
        className={styles.emptyLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="project-add-recent-toggle"
      >
        {t('ui.cli-monitor.project-add-on-this-computer')}
        <Icon icon={ChevronDown} size={14} />
      </button>
      <button
        type="button"
        className={styles.emptyAdd}
        onClick={() => void browse()}
        data-testid="project-add-folder"
      >
        <Icon icon={Plus} size={16} />
        {t('ui.foundation.add')}
      </button>
      {menu}
    </div>
  );
};

export interface ProjectDialogProps {
  /** 编辑哪个项目；不给 = 新建 */
  project?: Project;
  onClose: () => void;
  /** 新建 / 保存成功后 */
  onSaved?: (p: Project) => void;
}

export const ProjectDialog: React.FC<ProjectDialogProps> = ({ project, onClose, onSaved }) => {
  useLocale();
  const editing = !!project;
  const [name, setName] = useState(project?.name ?? '');
  const [folders, setFolders] = useState<string[]>(project ? projectRoots(project) : []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const missing = new Set((project?.missing ?? []).map(workspaceKey));

  const primary = folders[0];
  const placeholder = primary ? baseName(primary) : t('ui.cli-monitor.project-name');

  const add = (dir: string) => {
    setError('');
    setFolders((l) => (l.some((p) => workspaceKey(p) === workspaceKey(dir)) ? l : [...l, dir]));
  };
  const remove = (dir: string) => setFolders((l) => l.filter((p) => p !== dir));
  const makePrimary = (dir: string) => setFolders((l) => [dir, ...l.filter((p) => p !== dir)]);

  const submit = async () => {
    if (!primary || busy) return;
    setBusy(true);
    setError('');
    const input = { name: name.trim() || baseName(primary), primary, folders: folders.slice(1) };
    try {
      const saved = project
        ? await projectsClient.update({ id: project.id, ...input })
        : await projectsClient.create(input);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async () => {
    if (!project) return;
    const ok = await confirmDialog({
      title: t('ui.cli-monitor.project-remove-confirm-title', project.name),
      message: t('ui.cli-monitor.project-remove-confirm-body'),
      confirmLabel: t('ui.cli-monitor.project-remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await projectsClient.remove(project.id);
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  };

  const footer = (
    <div className={styles.footer}>
      {editing && (
        <Button variant="danger" onClick={() => void removeProject()} data-testid="project-remove">
          {t('ui.cli-monitor.project-remove')}
        </Button>
      )}
      <span className={styles.spacer} />
      <Button variant="ghost" onClick={onClose}>
        {t('ui.foundation.cancel')}
      </Button>
      <Button
        variant="primary"
        disabled={!primary || busy}
        onClick={() => void submit()}
        data-testid="project-submit"
      >
        {editing ? t('ui.foundation.save') : t('ui.cli-monitor.project-create-title')}
      </Button>
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={
        editing ? t('ui.cli-monitor.project-edit-title') : t('ui.cli-monitor.project-create-title')
      }
      footer={footer}
      data-testid="project-dialog"
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={styles.nameField}>
          <span className={styles.nameIcon} aria-hidden>
            <Icon icon={Folder} size={16} />
          </span>
          <input
            className={styles.nameInput}
            value={name}
            placeholder={placeholder}
            aria-label={t('ui.cli-monitor.project-name')}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            data-testid="project-name"
          />
        </label>
        <div className={styles.sectionLabel}>{t('ui.cli-monitor.project-folders')}</div>
        <div className={styles.box} data-testid="project-folders">
          {folders.length === 0 ? (
            <AddFolderMenu exclude={folders} onAdd={add} variant="empty" />
          ) : (
            <>
              {folders.map((p, i) => {
                const bad = missing.has(workspaceKey(p));
                return (
                  <div
                    key={p}
                    className={styles.row}
                    data-testid="project-folder"
                    data-primary={i === 0 || undefined}
                    data-missing={bad || undefined}
                  >
                    <Icon icon={Folder} size={16} />
                    <span className={styles.rowName} title={p}>
                      {baseName(p)}
                    </span>
                    <span className={styles.rowPath} title={p}>
                      {bad ? t('ui.cli-monitor.project-folder-missing') : p}
                    </span>
                    {i === 0 ? (
                      <span
                        className={styles.primaryTag}
                        title={t('ui.cli-monitor.project-primary-hint')}
                      >
                        {t('ui.cli-monitor.project-primary')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.rowBtn}
                        title={t('ui.cli-monitor.project-set-primary')}
                        aria-label={t('ui.cli-monitor.project-set-primary')}
                        onClick={() => makePrimary(p)}
                        data-testid="project-set-primary"
                      >
                        <Icon icon={Star} size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.rowBtn}
                      title={t('ui.providers-schedule.task-folders-remove', baseName(p))}
                      aria-label={t('ui.providers-schedule.task-folders-remove', baseName(p))}
                      onClick={() => remove(p)}
                      data-testid="project-remove-folder"
                    >
                      <Icon icon={X} size={14} />
                    </button>
                  </div>
                );
              })}
              <AddFolderMenu exclude={folders} onAdd={add} variant="row" />
            </>
          )}
        </div>
        {folders.length > 1 && (
          <p className={styles.hint}>{t('ui.cli-monitor.project-primary-hint')}</p>
        )}
        {error && (
          <p className={styles.error} role="alert" data-testid="project-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
};
