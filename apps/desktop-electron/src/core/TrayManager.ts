/**
 * TrayManager —— 系统托盘：一键切换 Nomi 对话的模型、打开对话 / 模型设置。
 *
 * 菜单由统一网关状态生成（Nomi 对话的 main 模型；环境变量供应商也在网关里以 env-* 出现）。
 * 仅在未注入网关 models API 时退回 ProviderService（单测垫片）。只含名称，无 key，变化即重建。
 * `IG_DISABLE_TRAY=1` 可关闭（无托盘的桌面环境 / 测试）。
 */
import * as path from 'path';

import type { ProviderService, ProviderState } from '@nomi-ai/ai-runtime';
import type { SemanticGesture } from '@nomi-ai/character-contract';
import {
  avatarGesture,
  sendMascotCommand,
  type MascotCommand,
} from '@nomi-ai/core/ai/mascotCommand';
import type { AppEvents } from '@nomi-ai/core/core/appEvents';
import type { GatewayStateView } from '@nomi-ai/core/gateway/GatewayService';
import type { CoreI18n, Translate } from '@nomi-ai/core/i18n';
import type { ILoggerService } from '@nomi-ai/core/services/LoggerService';
import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import { APP_NAME } from '../brand';

import { assetsDir, iconImage, onTrayIcon } from './appIcon';

export interface ProviderMenuEntry {
  id: string | null;
  label: string;
  checked: boolean;
  enabled: boolean;
  /** 网关条目：点了之后设为 Nomi 对话 main 的 `供应商/模型` */
  ref?: string;
}

/**
 * 纯函数：网关状态 → 菜单项。每个启用的供应商一项；当前 main 所在的供应商打勾并显示当前模型，
 * 其余显示它第一个启用的模型（点了就切到那个模型）。
 */
export function gatewayMenuEntries(
  view: Pick<GatewayStateView, 'providers' | 'clients' | 'recentNomi'>,
  t: Translate,
): ProviderMenuEntry[] {
  const main = view.clients.nomi?.models.main ?? '';
  const find = (ref: string) => {
    const i = ref.indexOf('/');
    const p = i > 0 ? view.providers.find((x) => x.enabled && x.id === ref.slice(0, i)) : undefined;
    const m = p?.models.find((x) => x.enabled && x.id === ref.slice(i + 1));
    return p && m ? { p, m } : null;
  };
  // 最近用过的 5 个模型（§4.3）；当前的排第一
  const recent = [...new Set([main, ...(view.recentNomi ?? [])].filter(Boolean))]
    .map((ref) => ({ ref, hit: find(ref) }))
    .filter((x) => x.hit)
    .slice(0, 5);
  if (recent.length)
    return recent.map(({ ref, hit }) => ({
      id: hit!.p.id,
      label: t('{0} · {1}', providerName(hit!.p.name, t), hit!.m.label ?? hit!.m.id),
      checked: ref === main,
      enabled: true,
      ref,
    }));
  // 还没有使用记录：每个启用的供应商一项（它第一个能用的模型）
  return view.providers
    .filter((p) => p.enabled)
    .flatMap((p) => {
      const model = (
        p.models.find((m) => m.enabled && m.toolCalling !== false) ??
        p.models.find((m) => m.enabled)
      )?.id;
      if (!model) return [];
      return [
        {
          id: p.id,
          label: t('{0} · {1}', providerName(p.name, t), model),
          checked: false,
          enabled: true,
          ref: `${p.id}/${model}`,
        },
      ];
    });
}

/** 供应商显示名：预设名与「（环境变量）」后缀按当前语言翻译，用户自定义名字原样保留。 */
function providerName(name: string, t: Translate): string {
  const env = /^(.*)（环境变量）$/.exec(name);
  if (env) return t('electron.common.env', providerName(env[1]!, t));
  return t(name);
}

/** 纯函数：state → 「切换 provider」菜单项（便于单测）。 */
export function providerMenuEntries(state: ProviderState, t: Translate): ProviderMenuEntry[] {
  const current = state.effectiveProviderId;
  const entries: ProviderMenuEntry[] = state.providers
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.id,
      label: t(
        '{0} · {1}{2}',
        providerName(p.name, t),
        p.defaultModel,
        p.keys.length === 0 && !['ollama', 'lmstudio', 'custom'].includes(p.presetId)
          ? t('electron.common.no-key-configured')
          : '',
      ),
      checked: p.id === current,
      enabled: true,
    }));
  for (const e of state.envProviders) {
    entries.push({
      id: e.id,
      label: t('{0}{1}', providerName(e.name, t), e.hasKey ? '' : t('electron.common.no-key')),
      checked: e.id === current,
      enabled: e.hasKey,
    });
  }
  return entries;
}

/** 统一网关（Nomi 对话的模型分配） */
export interface TrayModelSource {
  state(): Pick<GatewayStateView, 'providers' | 'clients' | 'recentNomi'>;
  select(ref: string): void;
  onChange(fn: () => void): () => void;
}

export interface TrayManagerOptions {
  providers: ProviderService;
  /** 当前角色简称（人设，当前界面语言）：「<角色名> 动作」子菜单用，不写死官方角色名（§10.1） */
  characterName?: () => string | undefined;
  /** 角色名可能变了（换角色包 / 换界面语言后人设更新）：托盘菜单重建；返回取消订阅 */
  onCharacterChange?: (fn: () => void) => () => void;
  models?: TrayModelSource;
  /** 内核实例的界面语言（`core.i18n`）：菜单文案按它翻译，切换语言后重建 */
  i18n: Pick<CoreI18n, 't' | 'tName' | 'onChange'>;
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
  /** 内核的应用事件总线：托盘里的桌面角色动作 / 互动设置经它发给桌面角色窗口；缺省时不发 */
  events?: AppEvents;
}

/** 托盘「桌面角色动作」菜单项 */
/** 托盘「动作」菜单：语义手势（§10.5）→ 菜单文案；当前角色包没有映射的手势点了也不动 */
export const TRAY_MOTIONS: Array<[SemanticGesture, string]> = [
  ['wave', 'electron.common.wave'],
  ['nod', 'electron.common.nod'],
  ['shakeHead', 'electron.common.shake-head'],
  ['bow', 'electron.common.bow'],
  ['think', 'electron.common.chin-rest-thinking'],
  ['heart', 'electron.common.heart-gesture'],
  ['cheer', 'electron.common.cheer-fist-pump'],
  ['thumbsUp', 'electron.common.thumbs-up'],
  ['peace', 'electron.common.peace-sign'],
  ['celebrate', 'electron.common.celebrate'],
  ['clap', 'electron.common.clap'],
  ['shy', 'electron.common.shy'],
  ['apologize', 'electron.common.apologise'],
  ['surprise', 'electron.common.surprised'],
  ['yawn', 'electron.common.yawn'],
  ['stretch', 'electron.common.stretch'],
  ['goodnight', 'electron.common.good-night'],
];

/**
 * 托盘的强引用（模块级）：即使 TrayManager 实例被意外丢弃，Tray 也不会被 GC，
 * 否则 macOS 菜单栏图标会在一次 GC 后凭空消失。
 */
const liveTrays = new Set<Tray>();

export class TrayManager {
  private tray: Tray | null = null;
  private unsubscribe?: () => void;

  constructor(private readonly opts: TrayManagerOptions) {}

  private mascot(cmd: MascotCommand): void {
    sendMascotCommand(this.opts.events, cmd);
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
      this.tray.setToolTip(APP_NAME);
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
      this.unsubscribeModels = this.opts.models?.onChange(() => this.rebuild());
      // 切换界面语言后立即重建托盘菜单
      this.unsubscribeLocale = this.opts.i18n.onChange(() => this.rebuild());
      // 换角色包 / 人设随语言更新后，「<角色名>的动作」跟着变
      this.unsubscribeCharacter = this.opts.onCharacterChange?.(() => this.rebuild());
    } catch (error) {
      this.opts.logger.warn('托盘创建失败（不影响主功能）', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.tray = null;
    }
  }

  private unsubscribeLocale?: () => void;
  private unsubscribeCharacter?: () => void;
  private unsubscribeModels?: () => void;
  private unsubscribeIcon?: () => void;
  /** 仅测试用：当前是否持有存活的托盘 */
  isAlive(): boolean {
    return !!this.tray && !this.tray.isDestroyed();
  }

  rebuild(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const { t, tName } = this.opts.i18n;
    const state = this.opts.providers.state();
    const gw = this.opts.models?.state();
    // GatewayStore 是唯一来源：有 models API 就用网关菜单（可为空，引导去「模型」页）
    const entries = gw ? gatewayMenuEntries(gw, t) : providerMenuEntries(state, t);
    const providerItems: MenuItemConstructorOptions[] = entries.map((e) => ({
      label: e.label,
      type: 'radio',
      checked: e.checked,
      enabled: e.enabled && !state.overrideId,
      click: () => {
        try {
          if (e.ref) this.opts.models?.select(e.ref);
          else this.opts.providers.setActive(e.id);
          this.opts.logger.info('托盘切换模型', { id: e.id, ref: e.ref });
        } catch (error) {
          this.opts.logger.warn('托盘切换模型失败', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }));
    const template: MenuItemConstructorOptions[] = [
      { label: t('electron.common.open-ai-chat'), click: () => this.opts.openChat() },
      { type: 'separator' },
      {
        label: state.overrideId
          ? t('electron.common.chat-model-locked-by-nomi-provider')
          : t('electron.common.chat-model'),
        enabled: false,
      },
      ...providerItems,
      { label: t('electron.common.model-settings'), click: () => this.opts.openProviderPanel() },
      {
        label: t('electron.common.desktop-abilities-file-grants-activity-log'),
        click: () => this.opts.openDesktopPanel?.(),
      },
      { type: 'separator' },
      {
        label: tName(
          'electron.common.nomi-motions',
          this.opts.characterName?.() || t('ui.mascot-theme.the-mascot'),
        ),
        submenu: TRAY_MOTIONS.map(([name, label]) => ({
          label: t(label),
          click: () => avatarGesture(this.opts.events, name),
        })),
      },
      {
        label: t('electron.common.interaction-settings-click-through-gravity-stroll'),
        click: () => this.mascot({ type: 'open-panel', panel: 'interaction' }),
      },
      { type: 'separator' },
      { label: t('electron.common.quit'), click: () => this.opts.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private teardownSubscriptions(): void {
    this.unsubscribeLocale?.();
    this.unsubscribeCharacter?.();
    this.unsubscribeIcon?.();
    this.unsubscribe?.();
    this.unsubscribeModels?.();
    this.unsubscribeLocale =
      this.unsubscribeCharacter =
      this.unsubscribeIcon =
      this.unsubscribe =
      this.unsubscribeModels =
        undefined;
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
