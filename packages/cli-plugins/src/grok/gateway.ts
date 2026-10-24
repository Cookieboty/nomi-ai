/**
 * 网关侧入口：只导出数据（客户端规格等），由网关进程组装进内核（P9.5，网关的规格形状见 P6）。
 * 不 import node:* 与 main 入口。
 */
import { manifest } from './manifest';

export const gateway = {
  client: manifest.id,
  ingress: manifest.ingress,
  clientSpec: manifest.clientSpec,
} as const;
