/** 会话摘要卡 ↔ 完整变更工作台 的打开状态 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

import type { ChangeEntry } from '../../utils/sessionChanges';

export interface WorkbenchOpen {
  /** 聚焦某轮助手消息；缺省=会话全部 */
  messageId?: string;
  /** 初始选中文件 */
  file?: string;
  /** 打开时用的条目（可选；缺省由消费方从 messages 聚合） */
  entries?: ChangeEntry[];
  /** 左栏来源标签 */
  sourceLabel?: string;
}

interface ChangesUiValue {
  workbench: WorkbenchOpen | null;
  openWorkbench: (o?: WorkbenchOpen) => void;
  closeWorkbench: () => void;
}

const Ctx = createContext<ChangesUiValue | null>(null);

export const ChangesUiProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [workbench, setWorkbench] = useState<WorkbenchOpen | null>(null);
  const openWorkbench = useCallback((o: WorkbenchOpen = {}) => setWorkbench(o), []);
  const closeWorkbench = useCallback(() => setWorkbench(null), []);
  const value = useMemo(
    () => ({ workbench, openWorkbench, closeWorkbench }),
    [workbench, openWorkbench, closeWorkbench],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useChangesUi(): ChangesUiValue {
  const v = useContext(Ctx);
  if (!v) {
    return {
      workbench: null,
      openWorkbench: () => undefined,
      closeWorkbench: () => undefined,
    };
  }
  return v;
}
