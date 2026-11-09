/**
 * 端点相关的两组控件：
 *
 * - `EndpointControls`（输入栏左侧）：模型（编程助手还有权限模式），只留发消息时要用的。
 *   端点在新建对话时选定，之后不在输入栏切换。
 * - `NewChatContext`（新会话时输入框上方）：项目 · 分支，项目可以自由切换。
 * - `SessionControls`（对话区顶部）：「带上前文」标记。
 *   编程助手的供应商在侧栏底部信息卡的「新标签默认」（CliDefaultSource）里设，模型在模型按钮里换。
 */
import { Icon, t } from '@nomi-ai/ui';
import { History, X } from 'lucide-react';
import React from 'react';

import { selectMessageCount, useAiChatSelector } from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useGitBranch } from '../../hooks/useGitBranch';
import { useHarnessState } from '../../hooks/useHarnessState';
import { useNomiProject } from '../../hooks/useNomiProject';
import { gatewayClientAvailable } from '../../services/gatewayClient';
import { MAIN_TAB_ID, harnessClient } from '../../services/harnessClient';
import { useProject } from '../../services/projects';
import { BranchPicker } from '../BranchPicker';
import { ModelControls } from '../ModelControls';
import { NomiModelSwitch } from '../NomiModelSwitch';
import { BypassTip, PermissionModeChip, type PermissionTab } from '../PermissionModeChip';
import { ProjectPicker } from '../ProjectPicker';

import styles from './index.module.css';

/** 当前显示的是哪个端点，以及对应的 CLI 标签（Nomi 为 null） */
function useEndpoint() {
  const { isDev } = useChatMode();
  const tabs = useHarnessTabs();
  const harness = useHarnessState();
  const backend = tabs.isCliTab && tabs.activeTab ? tabs.activeTab.backend : harness?.backend;
  const cli = isDev && backend && backend !== 'nomi' ? backend : null;
  const tab = tabs.isCliTab ? tabs.activeTab : null;
  return { isDev, tabs, harness, cli, tab };
}

/**
 * 输入栏：模型 + 权限模式（Nomi 的模型走统一网关，与编程助手的模型按钮同位置）。
 * part：Codex 式布局里权限模式在左（mode）、模型在右（model）；不传则两个都画。
 */
export const EndpointControls: React.FC<{ part?: 'mode' | 'model' }> = ({ part }) => {
  const { tabs, harness, cli, tab } = useEndpoint();
  // 主对话标签切到 CLI 后端时也有权限模式（主进程里它同样是一个标签）
  const modeTab = tab ?? tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID) ?? null;
  // Nomi 对话（主标签）：权限模式作用在 Nomi 自己的工具上；主标签不在标签列表里，用 harness 状态
  // 等标签列表到了再判断：否则当前是 CLI 标签时会先闪一下 Nomi 的按钮
  const nomiTab: PermissionTab | null =
    tabs.state && !cli && harness?.backend === 'nomi'
      ? {
          id: MAIN_TAB_ID,
          backend: 'nomi',
          cwd: harness.cwd,
          title: '',
          permissionMode: harness.permissionMode,
        }
      : null;
  const model = part !== 'mode';
  const mode = part !== 'model';
  return (
    <>
      {model && !cli && gatewayClientAvailable() && <NomiModelSwitch />}
      {mode && nomiTab && <PermissionModeChip tab={nomiTab} />}
      {model && cli && modeTab && <ModelControls key={`model-${modeTab.backend}`} tab={modeTab} />}
      {mode && cli && modeTab && (
        <PermissionModeChip tab={modeTab} defaultMode={tabs.state?.defaultPermissionMode} />
      )}
    </>
  );
};

/** 输入框上方：「完全放开」提示条（只在 CLI 标签处于完全放开时出现） */
export const PermissionTip: React.FC = () => {
  const { tabs, cli, tab } = useEndpoint();
  const modeTab = tab ?? tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID) ?? null;
  if (!cli || !modeTab) return null;
  // 「全部自动」开着时完全放开就是默认档：不再每个标签都弹提示（权限按钮仍标红）
  if (tabs.state?.autoApprove) return null;
  const def = tabs.state?.defaultPermissionMode;
  return <BypassTip tab={modeTab} exitMode={def && def !== 'bypass' ? def : 'acceptEdits'} />;
};

/**
 * 当前 CLI 标签的项目。项目只在新会话（还没有消息）时能换，没有对话可带：
 * 工作目录是 CLI 会话身份的一部分，换项目直接开新会话，不再弹确认框。
 */
function useProjectSwitch() {
  const { cli, tab, tabs } = useEndpoint();
  // 主标签切到 CLI 后端时它不在标签列表的 activeTab 里
  const target = tab ?? tabs.state?.tabs.find((x) => x.id === MAIN_TAB_ID) ?? null;
  const changeProject = async (next: string) => {
    if (!target || next === target.projectId) return;
    await harnessClient.setTabProject(target.id, next, { carry: false }).catch(() => undefined);
  };
  return { cli, cwd: target?.cwd ?? '', projectId: target?.projectId, changeProject };
}

/**
 * 新会话（还没有消息）时贴在输入框上方的一条：项目（可搜索、可换、可新建；Nomi 对话可不使用）· 当前分支。
 * Nomi 对话的项目存在会话上，下一轮起生效；CLI 标签的工作目录是会话身份的一部分，空标签换项目直接开新会话。
 * 有了消息之后不再显示。
 */
const ContextBar: React.FC<{
  cwd: string;
  picker: React.ReactNode;
}> = ({ cwd, picker }) => {
  const branch = useGitBranch(cwd || null);
  return (
    <div className={styles.contextBar} data-testid="new-chat-context">
      {picker}
      {/* 主文件夹的当前分支：点开可以搜索、切换或新建分支（与右栏「改动」顶部同一个切换器） */}
      {branch && cwd && <BranchPicker cwd={cwd} branch={branch} up testId="new-chat-branch" />}
    </div>
  );
};

const NomiContextBar: React.FC = () => {
  const ws = useNomiProject();
  const project = useProject(ws.projectId);
  return (
    <ContextBar
      cwd={project?.primary ?? ''}
      picker={
        <ProjectPicker
          value={ws.projectId}
          onChange={ws.set}
          onClear={ws.clear}
          emptyLabel={t('ui.cli-monitor.no-project')}
          size="ms"
          variant="ghost"
          up
          testId="nomi-project"
        />
      }
    />
  );
};

const NewChatContextImpl: React.FC = () => {
  const { cli, cwd, projectId, changeProject } = useProjectSwitch();
  const { tabs, harness } = useEndpoint();
  const nomiCount = useAiChatSelector(selectMessageCount);
  if (!cli) {
    const onMain = !tabs.isCliTab && harness?.backend === 'nomi';
    if (!onMain || !harnessClient.available() || nomiCount > 0) return null;
    return <NomiContextBar />;
  }
  if ((tabs.messages ?? []).length > 0) return null;
  return (
    <ContextBar
      cwd={cwd}
      picker={
        <ProjectPicker
          value={projectId}
          onChange={changeProject}
          size="ms"
          variant="ghost"
          up
          testId="cli-project"
        />
      }
    />
  );
};

/** 没有 props：memo 后 App 根组件流式重渲染时不带着它重渲染（只跟自己订阅的上下文走） */
export const NewChatContext = React.memo(NewChatContextImpl);

/**
 * 对话区顶部：「带上前文」标记（换目录 / 换来源后才有）。
 * 编程助手的供应商在侧栏底部信息卡的「新标签默认」里设，已有会话用 `/model` 单独换。
 */
export const SessionControls: React.FC = () => {
  const { cli, tab } = useEndpoint();
  const carry = cli && tab?.carriedMessages ? tab : null;
  if (!carry) return null;

  return (
    <div className={styles.session} data-testid="session-controls">
      <span
        className={styles.carry}
        data-testid="cli-carry-chip"
        title={t(
          'ui.chat-settings.your-next-message-will-be-sent-to-the',
          String(carry.carriedMessages),
        )}
      >
        <Icon icon={History} size={14} />
        {t('ui.chat-settings.with-context', String(carry.carriedMessages))}
        <button
          type="button"
          className={styles.carryX}
          aria-label={t('ui.chat-settings.don-t-bring-the-context')}
          data-testid="cli-carry-clear"
          onClick={() => void harnessClient.clearTabCarry(carry.id).catch(() => undefined)}
        >
          <Icon icon={X} size={12} />
        </button>
      </span>
    </div>
  );
};
