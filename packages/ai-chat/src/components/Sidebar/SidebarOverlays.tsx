import type { ConvoOutcome } from '../../contexts/aiChatState';
import { MAX_RESULTS } from '../../hooks/useHistorySearchIndex';
import type { HarnessTabMeta } from '../../services/harnessClient';
import type { HistorySession } from '../../services/historyClient';
import type { Project } from '../../services/projects';
import { isInteractiveOnly } from '../../utils/cliCaps';
import { ConversationMenu } from '../ConversationMenu';
import { ProjectDialog } from '../ProjectDialog';

import type { ProjectGroup } from './projectGrouping';
import {
  ProjectPeek,
  useProjectPeekValue,
  type ProjectPeekController,
  type ProjectPeekState,
} from './ProjectPeek';
import { SearchDialog } from './SearchDialog';
import {
  SessionPeek,
  useSessionPeekValue,
  type SessionPeekController,
  type SessionPeekPos,
} from './SessionPeek';
import type { Meta } from './types';

type Peek = SessionPeekPos | null;
type Ctx = { x: number; y: number; anchor?: HTMLElement; id: string };
type HistMenu = { x: number; y: number; anchor?: HTMLElement; h: HistorySession };

interface ListPeekInput {
  peek?: Peek;
  getSnapshot?: SessionPeekController['getSnapshot'];
  subscribe?: SessionPeekController['subscribe'];
  hold: () => void;
  release: () => void;
}

interface ProjectPeekInput {
  peek?: ProjectPeekState | null;
  getSnapshot?: ProjectPeekController['getSnapshot'];
  subscribe?: ProjectPeekController['subscribe'];
  hold: () => void;
  release: () => void;
  hide: () => void;
}

const SessionPeekControlled: React.FC<{
  ctrl: SessionPeekController;
  visible: Meta[];
  tabById: Map<string, HarnessTabMeta>;
  runningIds: Set<string>;
  doneIds: Set<string>;
  outcomes?: Readonly<Record<string, ConvoOutcome>>;
  commitRename: (id: string, name: string | null) => void;
}> = ({ ctrl, visible, tabById, runningIds, doneIds, outcomes, commitRename }) => {
  const peek = useSessionPeekValue(ctrl);
  if (!peek) return null;
  const c = visible.find((x) => x.id === peek.id);
  if (!c) return null;
  const tab = c.tabId ? tabById.get(c.tabId) : undefined;
  return (
    <SessionPeek
      c={c}
      tab={tab}
      running={c.tabId ? undefined : runningIds.has(c.id)}
      done={c.tabId ? undefined : doneIds.has(c.id)}
      outcome={c.tabId ? undefined : outcomes?.[c.id]}
      top={peek.top}
      left={peek.left}
      onRename={commitRename}
      onHold={ctrl.hold}
      onRelease={ctrl.release}
    />
  );
};

const ProjectPeekControlled: React.FC<{
  ctrl: ProjectPeekController;
  projectGroups: readonly ProjectGroup[];
  onToggleProjectPin: (projectId: string) => void;
  onEditProject: (group: ProjectGroup) => void;
}> = ({ ctrl, projectGroups, onToggleProjectPin, onEditProject }) => {
  const peek = useProjectPeekValue(ctrl);
  if (!peek) return null;
  const g = projectGroups.find((x) => x.key === peek.projectId);
  if (!g) return null;
  return (
    <ProjectPeek
      group={g}
      anchor={peek.anchor}
      onTogglePin={onToggleProjectPin}
      onEdit={onEditProject}
      onHold={ctrl.hold}
      onRelease={ctrl.release}
      onClose={ctrl.hide}
    />
  );
};

interface SidebarOverlaysProps {
  list: Meta[];
  visible: Meta[];
  navList: Meta[];
  tabById: Map<string, HarnessTabMeta>;
  runningIds: Set<string>;
  /** 刚跑完一轮、还没点进去看的 Nomi 会话 id */
  doneIds: Set<string>;
  /** Nomi 会话最近一轮结束状态 */
  outcomes?: Readonly<Record<string, ConvoOutcome>>;
  onForkRequest?: (id: string) => void;
  startRename: (id: string) => void;
  togglePin: (id: string) => void;
  closeItem: (meta: Meta) => void;
  archiveItem: (id: string) => void;
  removeItem: (id: string) => void;
  onCtx: (id: string, e: React.MouseEvent) => void;
  /** 右键 / 「更多」里的「向右打开」（主区右侧面板打开这个会话） */
  openToSide?: (id: string) => void;
  canOpenToSide?: boolean;
  ctxP: { value: Ctx | null; closing: boolean };
  setCtx: (v: Ctx | null) => void;
  listPeek: ListPeekInput;
  projectPeek: ProjectPeekInput;
  projectGroups: readonly ProjectGroup[];
  onToggleProjectPin: (projectId: string) => void;
  onEditProject: (group: ProjectGroup) => void;
  commitRename: (id: string, name: string | null) => void;
  projectDialog: Project | 'new' | null;
  setProjectDialog: (v: Project | 'new' | null) => void;
  onProjectSaved: (p: Project) => void;
  searchOpen: boolean;
  query: string;
  setQuery: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSearchKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  closeSearch: () => void;
  searching: boolean;
  shown: React.ComponentProps<typeof SearchDialog>['shown'];
  results: { length: number };
  activeIdx: number;
  setActiveIdx: (i: number) => void;
  searchIndex: {
    loading: boolean;
    more: () => void;
  };
  canSearchMore: boolean;
  openingKey: string | null;
  open: (id: string) => void;
  openHistory: (h: HistorySession) => void;
  newLabel: string;
  newHint: string;
  onNew: () => void;
  onOpenTask?: (id: string) => void;
  onOpenAsset?: (file: string) => void;
  histMenuP: { value: HistMenu | null; closing: boolean };
  setHistMenu: (v: HistMenu | null) => void;
  deleteHistory: (h: HistorySession) => void;
}

/** 侧栏上的浮层：会话菜单、本机历史菜单、会话悬停卡、项目弹窗、搜索窗 */
export const SidebarOverlays: React.FC<SidebarOverlaysProps> = ({
  list,
  visible,
  navList,
  tabById,
  runningIds,
  doneIds,
  outcomes,
  onForkRequest,
  startRename,
  togglePin,
  closeItem,
  archiveItem,
  removeItem,
  onCtx,
  openToSide,
  canOpenToSide,
  ctxP,
  setCtx,
  listPeek,
  projectPeek,
  projectGroups,
  onToggleProjectPin,
  onEditProject,
  commitRename,
  projectDialog,
  setProjectDialog,
  onProjectSaved,
  searchOpen,
  query,
  setQuery,
  inputRef,
  onSearchKey,
  closeSearch,
  searching,
  shown,
  results,
  activeIdx,
  setActiveIdx,
  searchIndex,
  canSearchMore,
  openingKey,
  open,
  openHistory,
  newLabel,
  newHint,
  onNew,
  onOpenTask,
  onOpenAsset,
  histMenuP,
  setHistMenu,
  deleteHistory,
}) => (
  <>
    {ctxP.value &&
      (() => {
        const ctx = ctxP.value;
        const meta = list.find((x) => x.id === ctx.id);
        return (
          <ConversationMenu
            // 换了一行右键：重新挂载，焦点回到新菜单的第一项
            key={`${ctx.id}:${ctx.x}:${ctx.y}`}
            closing={ctxP.closing}
            anchor={ctx.anchor}
            x={ctx.x}
            y={ctx.y}
            isTab={Boolean(meta?.tabId)}
            onDismiss={() => setCtx(null)}
            onRename={() => startRename(ctx.id)}
            onPin={meta ? () => togglePin(ctx.id) : undefined}
            pinned={Boolean(meta?.pinnedAt)}
            onFork={
              meta && isInteractiveOnly(meta.backend) ? undefined : () => onForkRequest?.(ctx.id)
            }
            onClose={meta?.tabId ? () => closeItem(meta) : undefined}
            // 磁盘历史没有在面板里打开的会话：只有会话本体的菜单才给「向右打开」
            onOpenToSide={
              meta && canOpenToSide && openToSide ? () => void openToSide(ctx.id) : undefined
            }
            onArchive={meta && !meta.tabId ? () => archiveItem(ctx.id) : undefined}
            // 最近列表与本机历史统一确认后永久删除。
            onDelete={() => void removeItem(ctx.id)}
          />
        );
      })()}

    {listPeek.getSnapshot && listPeek.subscribe ? (
      <SessionPeekControlled
        ctrl={listPeek as SessionPeekController}
        visible={visible}
        tabById={tabById}
        runningIds={runningIds}
        doneIds={doneIds}
        outcomes={outcomes}
        commitRename={commitRename}
      />
    ) : (
      listPeek.peek &&
      (() => {
        const c = visible.find((x) => x.id === listPeek.peek?.id);
        if (!c) return null;
        const { top, left } = listPeek.peek;
        const tab = c.tabId ? tabById.get(c.tabId) : undefined;
        return (
          <SessionPeek
            c={c}
            tab={tab}
            running={c.tabId ? undefined : runningIds.has(c.id)}
            done={c.tabId ? undefined : doneIds.has(c.id)}
            outcome={c.tabId ? undefined : outcomes?.[c.id]}
            top={top}
            left={left}
            onRename={commitRename}
            onHold={listPeek.hold}
            onRelease={listPeek.release}
          />
        );
      })()
    )}

    {!projectDialog &&
      (projectPeek.getSnapshot && projectPeek.subscribe ? (
        <ProjectPeekControlled
          ctrl={projectPeek as ProjectPeekController}
          projectGroups={projectGroups}
          onToggleProjectPin={onToggleProjectPin}
          onEditProject={onEditProject}
        />
      ) : (
        projectPeek.peek &&
        (() => {
          const g = projectGroups.find((x) => x.key === projectPeek.peek?.projectId);
          if (!g) return null;
          return (
            <ProjectPeek
              group={g}
              anchor={projectPeek.peek.anchor}
              onTogglePin={onToggleProjectPin}
              onEdit={onEditProject}
              onHold={projectPeek.hold}
              onRelease={projectPeek.release}
              onClose={projectPeek.hide}
            />
          );
        })()
      ))}

    {projectDialog && (
      <ProjectDialog
        project={projectDialog === 'new' ? undefined : projectDialog}
        onClose={() => setProjectDialog(null)}
        onSaved={projectDialog === 'new' ? onProjectSaved : undefined}
      />
    )}
    {searchOpen && (
      <SearchDialog
        query={query}
        onQuery={setQuery}
        inputRef={inputRef}
        onKeyDown={onSearchKey}
        onClose={closeSearch}
        searching={searching}
        shown={shown}
        total={results.length}
        max={MAX_RESULTS}
        activeIdx={activeIdx}
        onActive={setActiveIdx}
        indexing={searchIndex.loading}
        canSearchMore={canSearchMore}
        onSearchMore={searchIndex.more}
        openingKey={openingKey}
        tabById={tabById}
        onOpenConv={(id) => (closeSearch(), void open(id))}
        onOpenHist={(h) => (closeSearch(), void openHistory(h))}
        onCtx={onCtx}
        recent={navList.slice(0, 6)}
        newLabel={newLabel}
        newHint={newHint}
        onNew={onNew}
        onOpenTask={onOpenTask}
        onOpenAsset={onOpenAsset}
      />
    )}
    {histMenuP.value && (
      <ConversationMenu
        x={histMenuP.value.x}
        y={histMenuP.value.y}
        isTab={false}
        closing={histMenuP.closing}
        anchor={histMenuP.value.anchor}
        onDismiss={() => setHistMenu(null)}
        onOpen={() => void openHistory(histMenuP.value!.h)}
        onDelete={() => void deleteHistory(histMenuP.value!.h)}
      />
    )}
  </>
);
