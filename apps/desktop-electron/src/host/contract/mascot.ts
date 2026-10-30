/**
 * D5 里要用窗口的处理函数（docs/design/core-host-decoupling.md §7.1、§12「P1b 实施约定」）：宿主片段。
 *
 * 契约声明在 packages/contract/src/app/mascot.ts。角色包 / 人设、聊天背景、旧的角色模型名、
 * `window.platform` 在内核（`@nomi-ai/core/contract/mascot`）；这里只实现：
 * - 看板娘窗口互动与大小（`mascot.*`，`MascotWindowController` 的公开方法）；
 * - 灵动岛（`island.*`，宿主的灵动岛窗口）；
 * - 旧窗口通道（`window.*`，`host/mascotWindowActions.ts`）。
 *
 * 看板娘窗口控制器的推送经内核的应用事件总线发布契约事件（窗口管理器建控制器时传入）。
 * `files.pathFor` 不能过线（只能在 preload 里对真实 File 调用），不在契约里。
 */

import type { MascotHostProcedureName } from '@nomi-ai/core/contract/mascot';
import { plain } from '@nomi-ai/core/contract/mascot';
import { need, type DomainHandlers } from '@nomi-ai/core/contract/types';

import type { WindowManager } from '../../core/WindowManager';
import type { IslandService, IslandSettings } from '../../island/IslandService';
import type { MascotWindowController } from '../../mascot/MascotWindowController';
import type { MascotWindowActions } from '../mascotWindowActions';

export type MascotHostHandlers = DomainHandlers<MascotHostProcedureName>;

/** 宿主片段在调用时读取的宿主对象（还没建好时为 undefined，处理函数报 UNAVAILABLE 或丢弃上报） */
export interface MascotHostDeps {
  windowManager(): Pick<WindowManager, 'mascotController'> | undefined;
  windowActions(): MascotWindowActions | undefined;
  island(): IslandService | undefined;
}

export function createMascotHostHandlers(deps: MascotHostDeps): MascotHostHandlers {
  /** 看板娘窗口还没建好时为 null：上报直接丢弃 */
  const controller = (): MascotWindowController | null =>
    deps.windowManager()?.mascotController ?? null;
  const ctl = (): MascotWindowController => need(controller(), 'mascotController');
  const win = () => need(deps.windowActions(), 'windowActions');
  const island = () => need(deps.island(), 'island');

  return {
    // —— 看板娘窗口互动
    'mascot.setShape': ({ rects }) => controller()?.reportShape(rects),
    'mascot.setHit': ({ hit }) => controller()?.reportHit(hit),
    'mascot.setGeometry': (box) => controller()?.reportGeometry(box),
    'mascot.dragStart': ({ screenX, screenY }) => controller()?.beginDrag(screenX, screenY),
    'mascot.dragMove': ({ screenX, screenY }) => controller()?.moveDrag(screenX, screenY),
    'mascot.dragEnd': () => controller()?.endDrag(),
    'mascot.setInteractionConfig': (cfg) => controller()?.setConfig(cfg),
    'mascot.wanderNow': () => controller()?.wanderNow(),
    'mascot.debugSnapshot': () => plain(ctl().snapshot()),

    // —— 看板娘大小
    'mascot.scaleGet': () => plain(ctl().scaleState()),
    'mascot.scaleSet': ({ scale }) => plain(ctl().scaleSet(scale)),
    'mascot.scaleStep': ({ dir }) => plain(ctl().scaleStep(dir)),
    'mascot.scaleWheel': ({ deltaY, deltaMode }) => plain(ctl().scaleWheel(deltaY, deltaMode)),
    'mascot.scaleReset': () => plain(ctl().scaleReset()),

    // —— 灵动岛
    'island.get': () => plain(island().get()),
    'island.set': (patch) => plain(island().set(patch as Partial<IslandSettings>)),
    'island.test': () => island().test(),

    // —— 旧窗口通道
    'window.quit': () => win().quitApp(),
    'window.setAlwaysOnTop': ({ flag }) => win().setAlwaysOnTop(flag),
    'window.move': ({ deltaX, deltaY }) => win().moveWindow(deltaX, deltaY),
    'window.getPosition': () => win().getPosition(),
    'window.setPosition': ({ x, y }) => win().setPosition(x, y),
    'window.getCursorPosition': () => win().getCursorPosition(),
    'window.openAiChat': () => win().openAiChat(),
    'window.openTaskBoard': () => win().openTaskBoard(),
  };
}
