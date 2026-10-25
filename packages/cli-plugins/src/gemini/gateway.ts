/**
 * 网关侧入口：客户端规格（纯数据，§5.5），由宿主在网关进程启动时登记进内核（P9.5）。
 * 不 import node:* 与 main 入口。
 */
import { DEFAULT_SESSION_KEY, type CliGatewayEntry } from '../shared/gatewaySpec';

import { manifest } from './manifest';

export const gateway: CliGatewayEntry = {
  client: manifest.id,
  ingress: manifest.ingress,
  clientSpec: {
    id: manifest.id,
    strictness: 'lenient',
    unknownToMain: true,
    sessionKey: DEFAULT_SESSION_KEY,
    heartbeat: { kind: 'comment' },
    legacy: { ingress: 'gemini' },
  },
};
