/**
 * 启动后默认界面（设置 → 通用 → 启动 Nomi 后默认显示；首次引导里也能选）。
 * 持久化到 userData/startup.json：`{ "defaultView": "mascot" | "main", "closeMain", "showMascot" }`。
 * 文件缺失 / 内容损坏 → 默认看板娘，所以老用户升级后行为不变，无需迁移。
 * 看板娘随时可以关闭（#55）；默认界面为看板娘时关掉她，默认界面会自动改为「软件主界面」，
 * 保证下次启动仍有界面可用。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AppEvents } from '../core/appEvents';
import { writePrivateFileAtomicAsync } from '../utils/privateFile';

import {
  CLOSE_MAIN_ACTIONS,
  DEFAULT_CLOSE_MAIN_ACTION,
  DEFAULT_STARTUP_VIEW,
  STARTUP_VIEWS,
  normalizeCloseMainAction,
  normalizeStartupView,
  type CloseMainAction,
  type StartupView,
} from './startupPlan';

export interface StartupState {
  defaultView: StartupView;
  /** 关闭主界面时：hide（默认，看板娘与托盘继续运行）/ quit（完全退出） */
  closeMain: CloseMainAction;
  /**
   * 显示桌面看板娘；false = 隐藏且不再播放语音（看板娘工具栏「关闭看板娘」/ 设置里可重新打开）。
   * 为 false 时 defaultView 一定是 main（关闭时自动改）；切回看板娘时自动重新打开。
   */
  showMascot: boolean;
}

export interface StartupServiceDeps {
  /** 偏好文件（userData/startup.json） */
  file: string;
  events: AppEvents;
}

export class StartupService {
  private readonly file: string;
  private readonly events: AppEvents;
  private state: StartupState = {
    defaultView: DEFAULT_STARTUP_VIEW,
    closeMain: DEFAULT_CLOSE_MAIN_ACTION,
    showMascot: true,
  };
  private listeners = new Set<(s: StartupState) => void>();

  constructor(deps: StartupServiceDeps) {
    this.file = deps.file;
    this.events = deps.events;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
        defaultView?: unknown;
        closeMain?: unknown;
        showMascot?: unknown;
      };
      const defaultView = normalizeStartupView(raw?.defaultView);
      this.state = {
        defaultView,
        closeMain: normalizeCloseMainAction(raw?.closeMain),
        showMascot: defaultView !== 'main' || raw?.showMascot !== false,
      };
    } catch {
      /* 首次运行 / 文件损坏：用默认 */
    }
  }

  get(): StartupState {
    return { ...this.state };
  }

  /** 部分更新：只改传入的字段；任一字段非法则整体拒绝、不落盘 */
  async set(patch: unknown): Promise<StartupState> {
    const p = (patch ?? null) as {
      defaultView?: unknown;
      closeMain?: unknown;
      showMascot?: unknown;
    } | null;
    if (
      !p ||
      typeof p !== 'object' ||
      (p.defaultView === undefined && p.closeMain === undefined && p.showMascot === undefined)
    ) {
      throw new Error('empty startup settings patch');
    }
    if (
      p.defaultView !== undefined &&
      !(STARTUP_VIEWS as readonly unknown[]).includes(p.defaultView)
    ) {
      throw new Error(`unknown startup view: ${String(p.defaultView)}`);
    }
    if (
      p.closeMain !== undefined &&
      !(CLOSE_MAIN_ACTIONS as readonly unknown[]).includes(p.closeMain)
    ) {
      throw new Error(`unknown close action: ${String(p.closeMain)}`);
    }
    if (p.showMascot !== undefined && typeof p.showMascot !== 'boolean') {
      throw new Error(`invalid showMascot: ${String(p.showMascot)}`);
    }
    const explicitView = p.defaultView as StartupView | undefined;
    if (explicitView === 'mascot' && p.showMascot === false) {
      throw new Error('cannot pick the mascot as default view and close it at the same time');
    }
    let defaultView = explicitView ?? this.state.defaultView;
    // 明确切回看板娘为默认界面：她会被重新打开
    const showMascot =
      explicitView === 'mascot'
        ? true
        : ((p.showMascot as boolean | undefined) ?? this.state.showMascot);
    // 默认界面为看板娘时关掉她（#55）：默认界面改为软件主界面，保证下次启动有界面可用
    if (!showMascot && defaultView === 'mascot') defaultView = 'main';
    // 调用方从返回值 / startup.changed 拿到新的 defaultView，自行提示「默认界面已改为主界面」
    this.state = {
      defaultView,
      closeMain: (p.closeMain as CloseMainAction | undefined) ?? this.state.closeMain,
      showMascot,
    };
    const next = this.get();
    // 界面操作触发：Windows 文件被占用时的退避等待不挡主进程（#154）
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    await writePrivateFileAtomicAsync(this.file, JSON.stringify(next, null, 2));
    for (const fn of this.listeners) fn(next);
    this.events.publish('startup.changed', next);
    return next;
  }

  /** 设置变化（看板娘显示开关要立即生效）；返回取消订阅 */
  onChange(fn: (s: StartupState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
