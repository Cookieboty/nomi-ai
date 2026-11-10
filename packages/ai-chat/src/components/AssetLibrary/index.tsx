/**
 * 素材库：所有生成的图片——Nomi 的生图、编程助手（如 Grok）生成后复制过来的——统一在这里管理。
 * 入口在侧栏会话列表上方（醒目的一行）；打开后在主区整页显示，替换对话区（侧栏保持，对话区只隐藏不卸载），
 * 顶部按分类（插画 / 人物 / 风景 / 动物 / 其他，生成后自动分、可在查看器里改）、来源与搜索筛选，右边是已用空间；
 * 瀑布流里信息收在图片里；点一张图在查看器里看大图、提示词、标签与素材信息，左右切换，在文件夹中显示或删除。
 * 在侧栏切到别的会话 / 标签、新建对话时自动回到对话（参考 feat/2.1.0-image-gen-p0 的 useMediaHost）。
 * 数据来自内核 media/AssetLibrary.ts（契约 chatAssets.*）；生成 / 删除后内核推 chatAssets.changed。
 */
import { t } from '@nomi-ai/ui';
import { Images } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { selectFirstMessageId, useAiChatSelector } from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { hasTransport } from '../../services/api';
import { lazyComponent } from '../lazyPanels';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';
import { SideNavItem } from '../Sidebar/SideNavItem';

import styles from './index.module.css';
import { useAssets } from './useAssets';

export { ImageViewer, type AssetItem } from './ImageViewer';
export { useAssets } from './useAssets';

/** 素材库页主体：首次打开时才加载（不进对话窗首屏 chunk；首屏空闲后会预取） */
const AssetLibraryPage = lazyComponent(() =>
  import('./AssetLibraryPage').then((m) => m.AssetLibraryPage),
);

/** 侧栏入口：会话列表上方醒目的一行（收起时只显示图标） */
export const AssetLibraryNav: React.FC<{
  collapsed: boolean;
  active: boolean;
  count?: number;
  onOpen: () => void;
}> = ({ collapsed, active, count, onOpen }) => (
  <SideNavItem
    icon={Images}
    label={t('ui.media.asset-library')}
    collapsed={collapsed}
    active={active}
    count={count}
    onOpen={onOpen}
    testId="asset-library-open"
  />
);

/**
 * 素材库宿主：侧栏入口 + 主区整页。页面第一次打开后保持挂载（切回对话只隐藏）；
 * 切到别的会话 / 标签时自动回到对话。
 */
export function useAssetLibraryHost(collapsed: boolean) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // 入口上的数量：常驻订阅（生成 / 删除后跟着变）
  const { items } = useAssets(hasTransport());
  const show = useCallback(() => {
    setOpen(true);
    setMounted(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const [focus, setFocus] = useState<{ file: string; nonce: number } | null>(null);
  /** 搜索里点了素材：打开素材库并在查看器里打开这张图 */
  const openAsset = useCallback((file: string) => {
    setFocus((f) => ({ file, nonce: (f?.nonce ?? 0) + 1 }));
    setOpen(true);
    setMounted(true);
  }, []);
  const { fillComposer } = useChangesUi();
  // 以此修改 / 作为参考：回到对话，把带图片链接的一句话填进输入框
  const compose = useCallback(
    (text: string) => {
      setOpen(false);
      fillComposer(text);
    },
    [fillComposer],
  );
  // 在侧栏点了别的会话 / 切了标签 → 回到对话
  const first = useAiChatSelector(selectFirstMessageId);
  const tabId = useHarnessTabs().state?.activeTabId;
  const last = useRef({ first, tabId });
  useEffect(() => {
    if (last.current.first !== first || last.current.tabId !== tabId) setOpen(false);
    last.current = { first, tabId };
  }, [first, tabId]);
  const available = hasTransport();
  const count = items?.length;
  // 记住入口元素：侧栏是 React.memo，每次给新元素会让它跟着 App 根组件每帧重渲染
  const nav = useMemo(
    () =>
      available ? (
        <AssetLibraryNav collapsed={collapsed} active={open} count={count} onOpen={show} />
      ) : null,
    [available, collapsed, open, count, show],
  );
  if (!available) return { nav: null, page: null, chatHidden: false, close, openAsset: undefined };
  const page = mounted ? (
    <div className={styles.main} hidden={!open} data-testid="asset-library-main">
      <AssetLibraryPage active={open} onBack={close} onCompose={compose} focus={focus} />
    </div>
  ) : null;
  return { nav, page, chatHidden: open, close, openAsset };
}
