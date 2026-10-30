/**
 * 人设变化的契约事件 `persona.changed`；读取走契约 `persona.get`。本模块不认识窗口、不 import electron。
 */
import type { Persona, PersonaService } from './PersonaService';

/** 把人设变化发到应用事件总线；返回取消转发 */
export function forwardPersonaChanges(
  svc: PersonaService,
  publish: (event: 'persona.changed', payload: Persona) => void,
): () => void {
  return svc.onChange((p) => publish('persona.changed', p));
}
