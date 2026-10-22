/** 摘要卡「查看变更」→ 聚焦右侧文件栏；可选次要详情页（完整工作台） */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

import type { ChangeEntry } from '../../utils/sessionChanges';

export interface WorkbenchOpen {
  /** 聚焦某轮助手消息；缺省=会话全部 */
  messageId?: string;
  /** 初始选中文件 */
  file?: string;
  /** 打开时用的条目（可选；缺省由消费方从 messages 聚合） */
  entries?: ChangeEntry[];
  /** 来源标签 */
  sourceLabel?: string;
}

interface ChangesUiValue {
  /** 右侧文件栏聚焦请求（非全屏） */
  workbench: WorkbenchOpen | null;
  openWorkbench: (o?: WorkbenchOpen) => void;
  closeWorkbench: () => void;
  /** 次要：完整变更工作台（详情页） */
  detail: WorkbenchOpen | null;
  openDetail: (o?: WorkbenchOpen) => void;
  closeDetail: () => void;
}

const Ctx = createContext<ChangesUiValue | null>(null);

export const ChangesUiProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [workbench, setWorkbench] = useState<WorkbenchOpen | null>(null);
  const [detail, setDetail] = useState<WorkbenchOpen | null>(null);
  const openWorkbench = useCallback((o: WorkbenchOpen = {}) => setWorkbench(o), []);
  const closeWorkbench = useCallback(() => setWorkbench(null), []);
  const openDetail = useCallback((o: WorkbenchOpen = {}) => setDetail(o), []);
  const closeDetail = useCallback(() => setDetail(null), []);
  const value = useMemo(
    () => ({ workbench, openWorkbench, closeWorkbench, detail, openDetail, closeDetail }),
    [workbench, openWorkbench, closeWorkbench, detail, openDetail, closeDetail],
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
      detail: null,
      openDetail: () => undefined,
      closeDetail: () => undefined,
    };
  }
  return v;
}
