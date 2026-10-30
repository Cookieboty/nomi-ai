/**
 * 网关侧入口：客户端规格（纯数据，§5.5），由宿主在网关进程启动时登记进内核（P9.5）。
 * 不 import node:* 与 main 入口。
 */
import { manifest } from '@nomi-ai/cli-catalog/grok/manifest';

import { DEFAULT_SESSION_KEY, type CliGatewayEntry } from '../shared/gatewaySpec';

/** Grok Build：按官方结构用 serde 严格反序列化，缺字段 / 未知事件就丢掉整轮 */
export const gateway: CliGatewayEntry = {
  client: manifest.id,
  ingress: manifest.ingress,
  clientSpec: {
    id: manifest.id,
    strictness: 'strict',
    // 只接受 Responses 规范表里的事件（与 e2e-cli 的必填字段探测快照核对过）
    acceptedEvents: 'spec',
    // 会话标题 / 摘要、下一句提示没配置时 Grok 用内置名（实测 grok-4.6）
    helperModels: ['^grok-4\\.6'],
    // 占位模型名（清单 clientSpec.placeholderModel）：真实模型在标签绑定里，按主模型解析
    builtinModels: [{ pattern: `^${String(manifest.clientSpec.placeholderModel)}$`, slot: 'main' }],
    unknownToMain: true,
    sessionKey: DEFAULT_SESSION_KEY,
    heartbeat: { kind: 'comment' },
    legacy: { userAgent: 'grok' },
  },
};
