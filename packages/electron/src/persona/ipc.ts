/**
 * 人设的 IPC：`character:get-persona`（handle）与 `character:persona-changed`（推送）。
 * 广播由宿主注入（本模块不认识窗口、不 import electron）；P1 后改为契约的 `persona.get` / `persona.changed`。
 */
import { guardedHandle } from '../security/guardedIpc';

import type { Persona, PersonaService } from './PersonaService';

export const PERSONA_GET_CHANNEL = 'character:get-persona';
export const PERSONA_CHANGED_CHANNEL = 'character:persona-changed';

export interface PersonaIpcDeps {
  /** 把事件推给所有界面窗口 */
  broadcast: (channel: string, payload: Persona) => void;
  /** 测试注入；默认 guardedHandle（先校验 sender） */
  handle?: (channel: string, fn: () => unknown) => void;
}

/** 注册 handle 并转发变化事件；返回取消转发 */
export function registerPersonaIpc(svc: PersonaService, deps: PersonaIpcDeps): () => void {
  const handle =
    deps.handle ??
    ((channel: string, fn: () => unknown) =>
      guardedHandle(channel, fn, { owner: 'PersonaService', wrapErrors: false }));
  handle(PERSONA_GET_CHANNEL, () => svc.get());
  return svc.onChange((p) => deps.broadcast(PERSONA_CHANGED_CHANNEL, p));
}
