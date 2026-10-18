import { t as tr } from '@nomi-ai/ui';
import { Badge, Button, EmptyState, Input, Modal, Textarea } from '@nomi-ai/ui';
import { NotebookPen } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { desktopClient, type NoteMetaView, type NoteView } from '../../services/desktopClient';

import styles from './index.module.css';

interface Props {
  isVisible: boolean;
  onClose: () => void;
}

/**
 * 笔记：本地 markdown 笔记库（userData/desktop/notes）。搜索 / 新建 / 编辑 / 删除（进回收站，可撤销）。
 * 笔记会被知识库一起索引，所以放在「知识与记忆」里（设置页标签 / 顶栏快速视图都有）。
 */
export const NotesPanel: React.FC<Props> = ({ isVisible, onClose }) => {
  const [msg, setMsg] = useState('');
  if (!isVisible) return null;
  return (
    <Modal open onClose={onClose} title={tr('笔记')} size="lg" data-testid="notes-panel">
      <div className={styles.stack}>
        {msg && (
          <div className={styles.msg} role="status" data-testid="notes-msg">
            {msg}
          </div>
        )}
        <NotesBody onMsg={setMsg} />
      </div>
    </Modal>
  );
};

const NotesBody: React.FC<{ onMsg: (m: string) => void }> = ({ onMsg }) => {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Array<NoteMetaView & { snippet?: string }>>([]);
  const [edit, setEdit] = useState<Partial<NoteView> | null>(null);

  const load = useCallback(async () => setItems(await desktopClient.notes(query)), [query]);
  useEffect(() => {
    // 初次拉取 + 订阅后端变更：属于外部数据同步，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return desktopClient.onP2Changed((k) => k === 'notes' && void load());
  }, [load]);

  const open = async (id: string) => setEdit(await desktopClient.readNote(id));
  const save = async () => {
    if (!edit) return;
    const n = await desktopClient.saveNote({
      id: edit.id,
      title: edit.title ?? '',
      body: edit.body ?? '',
      tags: (edit.tags ?? []).filter(Boolean),
    });
    onMsg(tr('已保存「{0}」', n.title));
    setEdit(null);
    void load();
  };
  const trash = async (id: string, title: string) => {
    if (await desktopClient.trashNote(id))
      onMsg(tr('已移到回收站：「{0}」（可在操作记录里撤销）', title));
    setEdit(null);
    void load();
  };

  if (edit)
    return (
      <div className={styles.stack} data-testid="note-editor">
        <Input
          placeholder={tr('标题')}
          value={edit.title ?? ''}
          onChange={(e) => setEdit({ ...edit, title: e.target.value })}
          data-testid="note-title"
        />
        <Input
          placeholder={tr('标签（用逗号分隔）')}
          value={(edit.tags ?? []).join(', ')}
          onChange={(e) =>
            setEdit({ ...edit, tags: e.target.value.split(/[,，]/).map((t) => t.trim()) })
          }
          data-testid="note-tags"
        />
        <Textarea
          rows={10}
          placeholder={tr('正文（markdown）')}
          value={edit.body ?? ''}
          onChange={(e) => setEdit({ ...edit, body: e.target.value })}
          data-testid="note-body"
        />
        <div className={styles.row}>
          <Button variant="primary" onClick={() => void save()} data-testid="note-save">
            {tr('保存')}
          </Button>
          <Button onClick={() => setEdit(null)}>{tr('取消')}</Button>
          {edit.id && (
            <Button variant="danger" onClick={() => void trash(edit.id!, edit.title ?? '')}>
              {tr('删除')}
            </Button>
          )}
        </div>
      </div>
    );

  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <Input
          placeholder={tr('搜索标题 / 标签 / 正文')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="notes-search"
          style={{ flex: 1 }}
        />
        <Button
          variant="primary"
          onClick={() => setEdit({ title: '', body: '', tags: [] })}
          data-testid="note-new"
        >
          {tr('新建笔记')}
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={NotebookPen}
          title={query ? tr('没有匹配的笔记') : tr('还没有笔记')}
          description={tr('可以让 Nomi 帮你记：「帮我记一下……」')}
        />
      ) : (
        <ul className={styles.cards} data-testid="notes-list">
          {items.map((n) => (
            <li key={n.id} className={styles.cardItem}>
              <button type="button" className={styles.cardBtn} onClick={() => void open(n.id)}>
                <strong>{tr(n.title)}</strong>
                <span className={styles.hint}>{new Date(n.updated).toLocaleString()}</span>
                {n.snippet && <span className={styles.snippet}>{n.snippet}</span>}
              </button>
              <span className={styles.row}>
                {n.tags.map((t) => (
                  <Badge key={t}>#{t}</Badge>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
