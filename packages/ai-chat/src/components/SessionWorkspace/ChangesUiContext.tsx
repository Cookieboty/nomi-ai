/**
 * 摘要卡「查看变更」→ 中栏 Diff + 右栏定位文件；可选次要详情页（完整工作台）。
 * 中栏是唯一的查看区：右栏只导航，它的文件预览（未提交 / 磁盘文件）也渲染进中栏的 previewSlot。
 */
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
  /** 右栏正在预览未提交 / 磁盘文件（中栏让给预览，与 workbench 互斥） */
  previewOpen: boolean;
  setPreviewOpen: (open: boolean) => void;
  /** 中栏预览挂载点（右栏用 portal 渲染进来） */
  previewSlot: HTMLElement | null;
  setPreviewSlot: (el: HTMLElement | null) => void;
}

const Ctx = createContext<ChangesUiValue | null>(null);

export const ChangesUiProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [workbench, setWorkbench] = useState<WorkbenchOpen | null>(null);
  const [detail, setDetail] = useState<WorkbenchOpen | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSlot, setPreviewSlot] = useState<HTMLElement | null>(null);
  const openWorkbench = useCallback((o: WorkbenchOpen = {}) => setWorkbench(o), []);
  const closeWorkbench = useCallback(() => setWorkbench(null), []);
  const openDetail = useCallback((o: WorkbenchOpen = {}) => setDetail(o), []);
  const closeDetail = useCallback(() => setDetail(null), []);
  const value = useMemo(
    () => ({
      workbench,
      openWorkbench,
      closeWorkbench,
      detail,
      openDetail,
      closeDetail,
      previewOpen,
      setPreviewOpen,
      previewSlot,
      setPreviewSlot,
    }),
    [
      workbench,
      openWorkbench,
      closeWorkbench,
      detail,
      openDetail,
      closeDetail,
      previewOpen,
      previewSlot,
    ],
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
      previewOpen: false,
      setPreviewOpen: () => undefined,
      previewSlot: null,
      setPreviewSlot: () => undefined,
    };
  }
  return v;
}
