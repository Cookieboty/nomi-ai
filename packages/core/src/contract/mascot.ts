/**
 * D5 里不碰窗口的处理函数（docs/design/core-host-decoupling.md §7.1、§12「P1b 实施约定」）。
 *
 * 契约声明在 packages/contract/src/app/mascot.ts。这里实现角色包 / 人设、聊天背景、旧的角色模型名与
 * `window.platform`；看板娘窗口互动（`mascot.*` 的光标 / 拖拽 / 大小）、灵动岛（`island.*`）与旧窗口
 * 通道（`window.*`）要用宿主的窗口，由宿主的契约片段实现（`MascotHostProcedureName`；Electron：
 * host-electron `host/contract/mascot.ts`）。
 *
 * D5 的事件（看板娘窗口控制器的光标 / 运动 / 物理 / 大小、看板娘指令与窗口鼠标进出）由服务与宿主的窗口
 * 控制器直接经事件总线发布契约事件（`events.publish('mascot.cursor', …)`）。
 */

import type { MascotProcedureName } from '@nomi-ai/contract/app';
import { CHAT_BG_ERROR } from '@nomi-ai/types';

import { t } from '../i18n';
import { defaultSystemPrompt } from '../persona/systemPrompt';

import { need, type AppHandlerContext, type ContractDeps, type DomainHandlers } from './types';

/** 内核实现的 D5 过程 */
type MascotCoreProcedureName =
  | 'mascot.saveModel'
  | 'mascot.getSavedModel'
  | 'character.getActivePack'
  | 'persona.get'
  | 'persona.systemPrompt'
  | 'chatBg.get'
  | 'chatBg.set'
  | 'chatBg.reset'
  | 'chatBg.pickImage'
  | 'window.platform';

/** 宿主实现的 D5 过程：看板娘窗口互动与大小、灵动岛、旧窗口通道 */
export type MascotHostProcedureName = Exclude<MascotProcedureName, MascotCoreProcedureName>;

export type MascotCoreHandlers = DomainHandlers<MascotCoreProcedureName>;

/**
 * 接口类型 → 同形的对象类型：契约里会演进的返回值是 looseObject（类型带索引签名），
 * TypeScript 不让接口直接赋给它；映射类型可以。运行时原样返回。
 */
export type Plain<T> = { [K in keyof T]: T[K] };
export const plain = <T extends object>(value: T): Plain<T> => value;

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

export function createMascotCoreHandlers(deps: ContractDeps): MascotCoreHandlers {
  const { services } = deps;
  const config = () => need(services.config, 'config');

  return {
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
    'persona.systemPrompt': () =>
      defaultSystemPrompt(need(services.persona, 'persona').get(), (key) => t(key)),

    // —— 聊天主面板背景（只在对话窗口调用：选图对话框挂在对话窗口上）
    'chatBg.get': () => plain(need(services.chatBg, 'chatBg').get()),
    'chatBg.set': (patch) => need(services.chatBg, 'chatBg').set(patch).then(plain),
    'chatBg.reset': () => need(services.chatBg, 'chatBg').reset().then(plain),
    'chatBg.pickImage': (_input, ctx) =>
      withChatBgErrors(ctx, () => need(services.chatBg, 'chatBg').pickImage('chat')).then(plain),

    'window.platform': () => deps.ports.app.platform(),
  };
}
