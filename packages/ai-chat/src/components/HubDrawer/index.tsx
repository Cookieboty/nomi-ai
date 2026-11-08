/**
 * 知识 · 记忆 · 日程抽屉：侧栏底部入口、输入框「+」菜单与快捷键打开，从右侧滑出（与「扩展 / MCP」一样），
 * 内容与「设置 → 知识与记忆」同一套标签页。面板以内嵌方式渲染在抽屉里；头部「在设置中打开」带上当前标签。
 */
import { Modal, ModalHostContext, t, type ModalHost } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import { KnowledgeSection } from '../SettingsView/KnowledgeSection';
import type { KnowledgeTab } from '../SettingsView/sections';

import styles from './index.module.css';

export const HubDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  onOpenSettings: (tab: KnowledgeTab) => void;
}> = ({ open, onClose, onOpenSettings }) => {
  const [tab, setTab] = useState<KnowledgeTab>('kb');
  const drawer = useMemo<ModalHost>(
    () => ({ mode: 'drawer', onOpenSettings: () => onOpenSettings(tab) }),
    [onOpenSettings, tab],
  );
  const inline = useMemo<ModalHost>(() => ({ mode: 'inline', hideTitle: true }), []);
  return (
    <ModalHostContext.Provider value={drawer}>
      <Modal
        open={open}
        onClose={onClose}
        title={t('ui.chat-settings.knowledge-memory-schedule')}
        size="lg"
        bodyClassName={styles.body}
        data-testid="hub-drawer"
      >
        <ModalHostContext.Provider value={inline}>
          <KnowledgeSection tab={tab} onTab={setTab} />
        </ModalHostContext.Provider>
      </Modal>
    </ModalHostContext.Provider>
  );
};
