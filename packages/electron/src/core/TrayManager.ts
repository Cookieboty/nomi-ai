/**
 * TrayManager —— 系统托盘：一键切换 AI provider、打开对话 / Provider 设置。
 *
 * 菜单由 ProviderService.state() 生成（只含名称与掩码信息，无 key），store 变化即重建。
 * `IG_DISABLE_TRAY=1` 可关闭（无托盘的桌面环境 / 测试）。
 */
import * as path from 'path';

import type { ProviderService, ProviderState } from '@nomi-ai/ai-runtime';
import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import { APP_DISPLAY_NAME } from '../brand';
import { onLocaleChange, t } from '../i18n';
import type { ILoggerService } from '../services/LoggerService';

import { assetsDir, iconImage, onTrayIcon } from './appIcon';

export interface ProviderMenuEntry {
  id: string | null;
  label: string;
  checked: boolean;
  enabled: boolean;
}

/** 供应商显示名：预设名与「（环境变量）」后缀按当前语言翻译，用户自定义名字原样保留。 */
function providerName(name: string): string {
  const env = /^(.*)（环境变量）$/.exec(name);
  if (env) return t('{0}（环境变量）', providerName(env[1]!));
  return t(name);
}

/** 纯函数：state → 「切换 provider」菜单项（便于单测）。 */
export function providerMenuEntries(state: ProviderState): ProviderMenuEntry[] {
  const current = state.effectiveProviderId;
  const entries: ProviderMenuEntry[] = state.providers
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.id,
      label: t(
        '{0} · {1}{2}',
        providerName(p.name),
        p.defaultModel,
        p.keys.length === 0 && !['ollama', 'lmstudio', 'custom'].includes(p.presetId)
          ? t('（未配置 key）')
          : '',
      ),
      checked: p.id === current,
      enabled: true,
    }));
  for (const e of state.envProviders) {
    entries.push({
      id: e.id,
      label: t('{0}{1}', providerName(e.name), e.hasKey ? '' : t('（无 key）')),
      checked: e.id === current,
      enabled: e.hasKey,
    });
  }
  return entries;
}

export interface TrayManagerOptions {
  providers: ProviderService;
  logger: ILoggerService;
  openChat: () => void;
  /**
   * 左键点击托盘图标（仅 Windows；macOS 点击会弹出菜单）。
   * 返回 true 表示已处理（例如「启动后默认显示主界面」时打开主界面）；缺省 / 返回 false 时保持原样（什么都不做）。
   */
  onActivate?: () => boolean;
  openProviderPanel: () => void;
  /** 桌面能力设置（授权文件夹 / 权限 / 操作记录） */
  openDesktopPanel?: () => void;
  quit: () => void;
  /** 屏幕记忆（开启时托盘提示 + 菜单「暂停」）；可选 */
  screenMemory?: {
    active(): boolean;
    onChange(fn: () => void): () => void;
    pause(minutes: number): void;
    open(): void;
  };
}

/** 托盘「看板娘动作」菜单项 */
export const TRAY_MOTIONS: Array<[string, string]> = [
  ['wave', '挥手'],
  ['nod', '点头'],
  ['shake', '摇头'],
  ['bow', '鞠躬'],
  ['think', '托腮思考'],
  ['heart', '比心'],
  ['cheer', '加油握拳'],
  ['thumbs_up', '点赞'],
  ['peace', '剪刀手'],
  ['celebrate', '庆祝'],
  ['clap', '鼓掌'],
  ['shy', '害羞'],
  ['sorry', '道歉'],
  ['surprise', '惊讶'],
  ['yawn', '打哈欠'],
  ['stretch', '伸懒腰'],
  ['goodnight', '晚安'],
];

/**
 * 托盘的强引用（模块级）：即使 TrayManager 实例被意外丢弃，Tray 也不会被 GC，
 * 否则 macOS 菜单栏图标会在一次 GC 后凭空消失。
 */
const liveTrays = new Set<Tray>();

export class TrayManager {
  private tray: Tray | null = null;
  private unsubscribe?: () => void;
  private unsubscribeScreen?: () => void;

  constructor(private readonly opts: TrayManagerOptions) {}

  /** 屏幕记忆开启时：托盘提示文字 + 菜单顶部醒目的状态与暂停入口 */
  private screenMenu(): MenuItemConstructorOptions[] {
    const sm = this.opts.screenMemory;
    const on = !!sm?.active();
    this.tray?.setToolTip(on ? t('Nomi · ● 屏幕记忆中') : 'Nomi');
    if (!sm || !on) return [];
    return [
      { label: t('● 屏幕记忆中（仅保存在本机）'), click: () => sm.open() },
      { label: t('暂停屏幕记忆 1 小时'), click: () => sm.pause(60) },
      { type: 'separator' },
    ];
  }

  /** 取一张一定非空的托盘图：macOS 单色 Template，其余彩色；读不到就退回应用图标 */
  private trayImage(): NativeImage {
    const mac = process.platform === 'darwin';
    let icon = mac
      ? nativeImage.createFromPath(path.join(assetsDir(), 'trayTemplate.png'))
      : iconImage('tray');
    if (icon.isEmpty()) icon = iconImage('tray');
    if (icon.isEmpty()) icon = iconImage('window').resize({ width: 18, height: 18 });
    if (mac && !icon.isEmpty()) icon.setTemplateImage(true);
    return icon;
  }

  /** 托盘被销毁（外部 destroy / 系统回收）时重建；在应用被激活等时机调用，幂等 */
  ensureAlive(): boolean {
    if (process.env.IG_DISABLE_TRAY === '1') return false;
    if (this.tray && !this.tray.isDestroyed()) return false;
    if (this.tray) liveTrays.delete(this.tray);
    this.tray = null;
    this.teardownSubscriptions();
    this.start();
    this.opts.logger.warn('托盘已被销毁，已重建');
    return true;
  }

  start(): void {
    if (process.env.IG_DISABLE_TRAY === '1' || this.tray) return;
    try {
      this.tray = new Tray(this.trayImage());
      liveTrays.add(this.tray);
      // 非 macOS 跟随图标变体；永远不把空图设给托盘（空图 = 图标消失）
      this.unsubscribeIcon = onTrayIcon((img) => {
        if (!img.isEmpty() && this.tray && !this.tray.isDestroyed()) this.tray.setImage(img);
      });
      this.tray.setToolTip(APP_DISPLAY_NAME);
      if (process.platform === 'win32' && this.opts.onActivate) {
        const onActivate = this.opts.onActivate;
        this.tray.on('click', () => {
          try {
            onActivate();
          } catch (error) {
            this.opts.logger.warn('托盘点击处理失败', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
      this.rebuild();
      this.unsubscribe = this.opts.providers.onChange(() => this.rebuild());
      this.unsubscribeScreen = this.opts.screenMemory?.onChange(() => this.rebuild());
      // 切换界面语言后立即重建托盘菜单
      this.unsubscribeLocale = onLocaleChange(() => this.rebuild());
    } catch (error) {
      this.opts.logger.warn('托盘创建失败（不影响主功能）', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.tray = null;
    }
  }

  private unsubscribeLocale?: () => void;
  private unsubscribeIcon?: () => void;
  /** 仅测试用：当前是否持有存活的托盘 */
  isAlive(): boolean {
    return !!this.tray && !this.tray.isDestroyed();
  }

  rebuild(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const state = this.opts.providers.state();
    const providerItems: MenuItemConstructorOptions[] = providerMenuEntries(state).map((e) => ({
      label: e.label,
      type: 'radio',
      checked: e.checked,
      enabled: e.enabled && !state.overrideId,
      click: () => {
        try {
          this.opts.providers.setActive(e.id);
          this.opts.logger.info('托盘切换 provider', { id: e.id });
        } catch (error) {
          this.opts.logger.warn('托盘切换 provider 失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }));
    const template: MenuItemConstructorOptions[] = [
      ...this.screenMenu(),
      { label: t('打开 AI 对话'), click: () => this.opts.openChat() },
      { type: 'separator' },
      {
        label: state.overrideId ? t('AI Provider（已被 NOMI_PROVIDER 锁定）') : 'AI Provider',
        enabled: false,
      },
      ...providerItems,
      { label: t('Provider 设置…'), click: () => this.opts.openProviderPanel() },
      { label: t('桌面能力（文件授权 / 操作记录）…'), click: () => this.opts.openDesktopPanel?.() },
      { type: 'separator' },
      {
        label: t('Nomi 动作'),
        submenu: TRAY_MOTIONS.map(([name, label]) => ({
          label: t(label),
          click: () => broadcastMascotCommand({ type: 'motion', name }),
        })),
      },
      {
        label: t('互动设置（穿透 / 重力 / 散步）…'),
        click: () => broadcastMascotCommand({ type: 'open-panel', panel: 'interaction' }),
      },
      { type: 'separator' },
      { label: t('退出'), click: () => this.opts.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private teardownSubscriptions(): void {
    this.unsubscribeLocale?.();
    this.unsubscribeIcon?.();
    this.unsubscribe?.();
    this.unsubscribeScreen?.();
    this.unsubscribeLocale = this.unsubscribeIcon = this.unsubscribe = undefined;
    this.unsubscribeScreen = undefined;
  }

  dispose(): void {
    this.teardownSubscriptions();
    if (this.tray) {
      liveTrays.delete(this.tray);
      if (!this.tray.isDestroyed()) this.tray.destroy();
    }
    this.tray = null;
  }
}
