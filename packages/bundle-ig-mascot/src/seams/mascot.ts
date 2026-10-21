/**
 * 渲染后端无关的看板娘 seam 名称。
 *
 * 历史原因，服务 key（`ctx.live2d`）、IPC facade（`client.live2d.*`）与事件名（`live2d:touch` 等）
 * 仍沿用旧名以保持协议兼容；实际渲染的是 2D 看板娘 Nomi（见 renderer/src/mascot）。
 * 新代码请使用这里的 Mascot* 名称。
 */
export type {
  Live2dHitArea as MascotHitArea,
  Live2dTouchPayload as MascotTouchPayload,
  Live2dMotionEndPayload as MascotMotionEndPayload,
  Live2dEvent as MascotEvent,
  Live2dEventPayload as MascotEventPayload,
  Live2dHost as MascotHost,
  Live2dService as MascotService,
} from './live2d';
export { Live2dKey as MascotKey } from './live2d';
