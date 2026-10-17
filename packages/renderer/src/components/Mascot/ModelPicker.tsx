import { t as tr, Icon } from '@nomi-ai/ui';
import { Badge, Button, Modal, Tabs } from '@nomi-ai/ui';
import { Plus, Settings } from 'lucide-react';
import React, { useState } from 'react';

import { ImportTab } from './ImportTab';
import { ModelStoreTab } from './ModelStoreTab';
import styles from './style.module.css';
import { UserModelEditor } from './UserModelEditor';

import { useMascot } from '@/contexts/MascotContext';
import { useWaifuMessage } from '@/hooks/useWaifuMessage';
import { conditionsText, licenseLabel } from '@/mascot/licenseTerms';
import { MESSAGES } from '@/mascot/tips';

type Tab = 'mine' | 'store' | 'import';

const ORIGIN: Record<string, string> = { bundled: '内置', remote: '商店', user: '导入' };

/** 角色选择器：我的角色（内置 + 已下载 + 导入）/ 模型商店 / 导入 VRM。 */
export const ModelPicker: React.FC = () => {
  const { state, dispatch, selectModel } = useMascot();
  const { showMessage } = useWaifuMessage();
  const [tab, setTab] = useState<Tab>('mine');
  const [editing, setEditing] = useState<string | null>(null);
  const hasModelsApi = !!window.electronAPI?.models;
  if (!state.pickerOpen) return null;

  const close = () => {
    setEditing(null);
    dispatch({ type: 'SET_PICKER_OPEN', payload: false });
  };
  const editingModel = editing ? state.modelList.find((m) => m.name === editing) : undefined;

  return (
    <Modal open onClose={close} title={tr('选择角色')} size="lg" data-testid="model-picker">
      {hasModelsApi && (
        <Tabs<Tab>
          aria-label={tr('角色来源')}
          className={styles.tabs}
          value={tab}
          onChange={(t) => {
            setTab(t);
            setEditing(null);
          }}
          items={[
            { value: 'mine', label: tr('我的角色') },
            { value: 'store', label: tr('模型商店') },
            { value: 'import', label: tr('导入 VRM') },
          ]}
        />
      )}
      {tab === 'mine' && editingModel && (
        <UserModelEditor model={editingModel} onDone={() => setEditing(null)} />
      )}
      {tab === 'mine' && !editingModel && (
        <div className={styles.grid} data-testid="my-models">
          {state.modelList.map((m) => {
            const active = m.name === state.modelName;
            return (
              <div key={m.name} className={styles.cardWrap}>
                <button
                  type="button"
                  className={`${styles.card} ${active ? styles.active : ''}`}
                  data-testid={`model-option-${m.name}`}
                  aria-pressed={active}
                  title={[
                    `${m.displayName} · ${m.author} · ${m.license}`,
                    conditionsText(m.licenseTerms),
                  ]
                    .filter(Boolean)
                    .join('\n')}
                  onClick={() => {
                    selectModel(m.name);
                    close();
                    showMessage(MESSAGES.modelSwitched(m.displayName), 4000, 9);
                  }}
                >
                  {m.thumbnail ? (
                    <img src={m.thumbnail} alt={m.displayName} className={styles.thumb} />
                  ) : (
                    <div className={styles.thumb} />
                  )}
                  <span className={styles.name}>{m.displayName}</span>
                  <span className={styles.badges}>
                    <Badge tone={m.origin === 'user' ? 'warning' : active ? 'accent' : 'neutral'}>
                      {m.origin === 'user' ? tr('自备') : licenseLabel(m.license)}
                    </Badge>
                    {m.origin && m.origin !== 'bundled' && (
                      <Badge tone="neutral">{ORIGIN[m.origin]}</Badge>
                    )}
                  </span>
                </button>
                {m.origin === 'user' && (
                  <button
                    type="button"
                    className={styles.cardAction}
                    data-testid={`model-edit-${m.name}`}
                    title={tr('设置 / 替换 / 删除')}
                    onClick={() => setEditing(m.name)}
                  >
                    <Icon icon={Settings} />
                  </button>
                )}
              </div>
            );
          })}
          {hasModelsApi && (
            <div className={styles.cardWrap}>
              <button
                type="button"
                className={`${styles.card} ${styles.uploadCard}`}
                data-testid="model-option-upload"
                title={tr('导入自己的 .vrm 模型（仅保存在本机）')}
                onClick={() => setTab('import')}
              >
                <div className={`${styles.thumb} ${styles.uploadThumb}`} aria-hidden>
                  <Icon icon={Plus} size={22} />
                </div>
                <span className={styles.name}>{tr('上传自定义模型')}</span>
                <span className={styles.badges}>
                  <Badge tone="neutral">.vrm</Badge>
                </span>
              </button>
            </div>
          )}
        </div>
      )}
      {tab === 'store' && <ModelStoreTab />}
      {tab === 'import' && <ImportTab onImported={() => setTab('mine')} />}
      <div className={styles.footer}>
        <p className={styles.credit}>{tr('每个角色的作者与许可见「致谢」。')}</p>
        <Button
          size="sm"
          variant="ghost"
          data-testid="open-credits"
          onClick={() => dispatch({ type: 'SET_PANEL', payload: 'credits' })}
        >
          {tr('致谢 / Credits')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="open-interaction"
          onClick={() => dispatch({ type: 'SET_PANEL', payload: 'interaction' })}
        >
          {tr('互动设置')}
        </Button>
      </div>
    </Modal>
  );
};

export default ModelPicker;
