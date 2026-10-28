/**
 * D5 的处理函数与事件桥（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D5。契约声明在 packages/contract/src/app/mascot.ts；这里：
 * - `createMascotHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE）；
 * - `mascotEventBridge`：服务仍在 `events.publish` 的旧通道 → 契约事件。
 *
 * 看板娘窗口控制器（光标 / 运动 / 物理 / 大小）、看板娘指令与窗口鼠标进出原来直接 `webContents.send`；
 * 建 router 时把应用事件总线接到 `mascot/mascotEvents.ts`，它们从此经 `events.publish` 发布并桥接成契约事件。
 *
 * 窗口操作在 `host/mascotWindowActions.ts`；看板娘互动在
 * `MascotWindowController` 的公开方法里。`files.pathFor` 不能过线（只能在 preload 里对真实 File 调用），不在契约里。
 */

import type { MascotEventName, MascotProcedureName } from '@nomi-ai/contract/app';
import { setMascotAppEvents } from '@nomi-ai/core/mascot/mascotEvents';
import { CHAT_BG_ERROR } from '@nomi-ai/types';

import type { IslandSettings } from '../../island/IslandService';
import type { MascotWindowController } from '../../mascot/MascotWindowController';

import {
  need,
  type AppHandlerContext,
  type ContractDeps,
  type DomainHandlers,
  type EventBridgeMap,
} from './types';

export type MascotHandlers = DomainHandlers<MascotProcedureName>;

/**
 * 接口类型 → 同形的对象类型：契约里会演进的返回值是 looseObject（类型带索引签名），
 * TypeScript 不让接口直接赋给它；映射类型可以。运行时原样返回。
 */
type Plain<T> = { [K in keyof T]: T[K] };
const plain = <T extends object>(value: T): Plain<T> => value;

/** 背景图导入失败：主进程把错误码放在消息开头（types CHAT_BG_ERROR），这里转成契约错误码，消息不变 */
async function withChatBgErrors<T>(ctx: AppHandlerContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(CHAT_BG_ERROR.tooLarge)) ctx.fail('CHAT_BG_TOO_LARGE', message);
    if (message.startsWith(CHAT_BG_ERROR.unsupported)) ctx.fail('CHAT_BG_UNSUPPORTED', message);
    throw error;
  }
}

export function createMascotHandlers(deps: ContractDeps): MascotHandlers {
  const { services } = deps;
  // 看板娘相关推送从此经应用事件总线（同时成为契约事件），见 mascot/mascotEvents.ts
  setMascotAppEvents(deps.events);

  /** 看板娘窗口还没建好时为 null：上报直接丢弃 */
  const controller = (): MascotWindowController | null =>
    services.windowManager?.mascotController ?? null;
  const ctl = (): MascotWindowController => need(controller(), 'mascotController');
  const win = () => need(services.windowActions, 'windowActions');
  const config = () => need(services.config, 'config');

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

    // —— 旧的角色模型名（写配置并异步落盘）
    'mascot.saveModel': ({ modelName }) => {
      config().set('modelName', modelName);
      config()
        .save()
        .catch((error: unknown) =>
          deps.logger.error('保存模型配置失败', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    'mascot.getSavedModel': () => String(config().get<string>('modelName', '') ?? ''),

    // —— 角色包 / 人设
    'character.getActivePack': () =>
      plain(need(services.characterPack, 'characterPack').getActive()),
    'persona.get': () => plain(need(services.persona, 'persona').get()),

    // —— 灵动岛
    'island.get': () => plain(need(services.island, 'island').get()),
    'island.set': (patch) =>
      plain(need(services.island, 'island').set(patch as Partial<IslandSettings>)),
    'island.test': () => need(services.island, 'island').test(),

    // —— 聊天主面板背景（只在对话窗口调用：选图对话框挂在对话窗口上）
    'chatBg.get': () => plain(need(services.chatBg, 'chatBg').get()),
    'chatBg.set': (patch) => need(services.chatBg, 'chatBg').set(patch).then(plain),
    'chatBg.reset': () => need(services.chatBg, 'chatBg').reset().then(plain),
    'chatBg.pickImage': (_input, ctx) =>
      withChatBgErrors(ctx, () => need(services.chatBg, 'chatBg').pickImage('chat')).then(plain),

    // —— 旧窗口通道
    'window.quit': () => win().quitApp(),
    'window.setAlwaysOnTop': ({ flag }) => win().setAlwaysOnTop(flag),
    'window.move': ({ deltaX, deltaY }) => win().moveWindow(deltaX, deltaY),
    'window.getPosition': () => win().getPosition(),
    'window.setPosition': ({ x, y }) => win().setPosition(x, y),
    'window.getCursorPosition': () => win().getCursorPosition(),
    'window.openAiChat': () => win().openAiChat(),
    'window.openTaskBoard': () => win().openTaskBoard(),
    'window.platform': () => deps.ports.app.platform(),
  };
}

/** 旧通道 → 契约事件（服务 / 控制器照旧 `events.publish(<旧通道>)`） */
export const mascotEventBridge: EventBridgeMap<MascotEventName> = {
  'mascot:scale-changed': 'mascot.scaleChanged',
  'mascot:cursor': 'mascot.cursor',
  'mascot:body': 'mascot.body',
  'mascot:physics-event': 'mascot.physicsEvent',
  'mascot:command': 'mascot.command',
  'character:persona-changed': 'persona.changed',
  'chat-bg:changed': 'chatBg.changed',
  // 旧通道不带 payload
  'window-mouse-enter': { event: 'window.mouseEnter', map: () => null },
  'window-mouse-leave': { event: 'window.mouseLeave', map: () => null },
};
