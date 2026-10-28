/**
 * 人设变化的应用事件：`character:persona-changed`，事件桥转成契约事件 `persona.changed`
 * （host/contract/mascot.ts）；读取走契约 `persona.get`。本模块不认识窗口、不 import electron。
 */
import type { Persona, PersonaService } from './PersonaService';

export const PERSONA_CHANGED_CHANNEL = 'character:persona-changed';

/** 把人设变化发到应用事件总线；返回取消转发 */
export function forwardPersonaChanges(
  svc: PersonaService,
  publish: (channel: string, payload: Persona) => void,
): () => void {
  return svc.onChange((p) => publish(PERSONA_CHANGED_CHANNEL, p));
}
