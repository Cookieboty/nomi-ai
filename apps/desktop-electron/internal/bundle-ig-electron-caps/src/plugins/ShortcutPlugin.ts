import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

export interface ShortcutBinding {
  /** Electron accelerator（如 'CommandOrControl+Shift+Space'） */
  accelerator: string;
  /** 命令：由消费方分发到具体动作（如 'wake.toggle', 'screen.captureToAgent'） */
  command: string;
  /** 可选透传 payload */
  payload?: unknown;
}

export interface ShortcutConfig {
  bindings?: ShortcutBinding[];
  /** 宿主注入的全局快捷键与退出事件（Electron：`globalShortcut` / `app`）；不给时不注册快捷键 */
  host?: { app: AppLike; globalShortcut: GlobalShortcutLike };
}

export interface GlobalShortcutLike {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
  unregisterAll(): void;
  isRegistered(accelerator: string): boolean;
}

export interface AppLike {
  on(evt: 'will-quit', cb: () => void): unknown;
}

const DEFAULT_BINDINGS: ShortcutBinding[] = [
  { accelerator: 'CommandOrControl+Shift+Space', command: 'wake.toggle' },
  { accelerator: 'CommandOrControl+Shift+X', command: 'screen.captureToAgent' },
];

export const ShortcutPlugin = definePlugin<ShortcutConfig>({
  name: 'ShortcutPlugin',
  apply(ctx: PluginContext, cfg: ShortcutConfig) {
    if (!cfg.host) {
      ctx.logger.warn('ShortcutPlugin skipped: no globalShortcut injected by the host');
      return;
    }
    const { app, globalShortcut } = cfg.host;

    const bindings = cfg.bindings ?? DEFAULT_BINDINGS;
    const registered: string[] = [];

    for (const b of bindings) {
      const ok = globalShortcut.register(b.accelerator, () => {
        ctx.logger.info(`shortcut fired: ${b.accelerator} -> ${b.command}`);
        // 用 插件宿主 的通用事件通道派发；具体消费者可自行订阅
        ctx.emit('agent/pre-request', {
          shortcut: b.accelerator,
          command: b.command,
          payload: b.payload,
        });
      });
      if (ok) {
        registered.push(b.accelerator);
      } else {
        ctx.logger.warn(`shortcut register failed: ${b.accelerator}`);
      }
    }

    app.on('will-quit', () => {
      for (const acc of registered) {
        try {
          globalShortcut.unregister(acc);
        } catch (err) {
          ctx.logger.warn(`shortcut unregister failed: ${acc}`, err);
        }
      }
    });

    ctx.logger.info(`ShortcutPlugin ready: ${registered.length} bindings`);
  },
});
