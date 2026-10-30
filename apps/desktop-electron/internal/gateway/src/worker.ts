/**
 * 网关进程的消息循环（docs/design/unified-gateway.md §5.3）。
 * 主进程（GatewayService）通过 utilityProcess 的 parentPort 推送配置快照；网关回报监听地址、用量与错误。
 * 这里不依赖 Electron：port 只要有 on('message') / postMessage 即可，单测用假的 port。
 */
import fs from 'node:fs';

import type { GatewayConfig } from './config';
import type { KeyStatusEvent } from './cooldown';
import type { LearnEvent } from './learn';
import { readCatalogFile, setCatalogOverlay } from './models/catalog';
import { BindingTable, type BindingAck, type BindingMessage } from './route/binding';
import { createGateway, type GatewayHooks, type GatewayServer, type UsageEvent } from './server';

export type WorkerInbound =
  | { type: 'config'; config: GatewayConfig }
  | { type: 'stop' }
  /** 标签绑定（§6.7）：主进程收到 binding:ok 之后才启动 CLI */
  | BindingMessage;

export type WorkerOutbound =
  | { type: 'listening'; port: number; url: string }
  | { type: 'usage'; event: UsageEvent }
  | { type: 'learn'; event: LearnEvent }
  | { type: 'key-status'; event: KeyStatusEvent }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'stopped' }
  | BindingAck;

export interface WorkerPort {
  on(ev: 'message', fn: (e: { data: WorkerInbound }) => void): void;
  postMessage(m: WorkerOutbound): void;
}

export function runGatewayWorker(
  port: WorkerPort,
  hooks: Omit<GatewayHooks, 'onUsage' | 'onLearn' | 'onKeyStatus'> = {},
): void {
  let gw: GatewayServer | null = null;
  let listenKey = '';
  // 绑定表跟着网关进程走，不跟着某个监听实例：换端口重启网关时已登记的标签照常可用
  const bindings = new BindingTable();
  // 串行处理消息：启动是异步的，后到的配置要等前一次完成
  let chain = Promise.resolve();

  /**
   * 已加载的同步目录（路径 + 修改时间 + 大小）：变了才重读，配置每次推送都会带上路径。
   * 主进程在目录落盘成功后才推配置（#185），这里读到的就是这次同步的内容
   */
  let catalogKey = '';
  const statKey = (file: string | undefined): string => {
    try {
      if (!file) return '';
      const st = fs.statSync(file);
      return `${file}:${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  };
  const loadCatalog = (file: string | undefined) => {
    const key = statKey(file);
    if (key === catalogKey) return;
    catalogKey = key;
    setCatalogOverlay(file && key ? readCatalogFile(file) : null);
  };

  const apply = async (config: GatewayConfig) => {
    loadCatalog(config.catalogFile);
    const key = `${config.host}:${config.port}`;
    if (gw && key === listenKey) {
      gw.update(config);
      return;
    }
    gw?.stop();
    gw = createGateway(config, {
      ...hooks,
      bindings,
      onUsage: (event) => port.postMessage({ type: 'usage', event }),
      onLearn: (event) => port.postMessage({ type: 'learn', event }),
      onKeyStatus: (event) => port.postMessage({ type: 'key-status', event }),
    });
    try {
      await gw.start();
      listenKey = key;
      const a = gw.address();
      port.postMessage({
        type: 'listening',
        port: a?.port ?? config.port,
        url: gw.listenUrl() ?? '',
      });
    } catch (e) {
      gw = null;
      listenKey = '';
      // 端口被占用等：主进程负责提示与重试
      port.postMessage({ type: 'error', message: (e as Error).message, fatal: true });
    }
  };

  port.on('message', (e) => {
    const m = e.data;
    // 绑定消息不排在配置后面：同步处理，立刻应答（主进程在等它才启动 CLI）
    if (m.type === 'binding:add' || m.type === 'binding:update' || m.type === 'binding:remove') {
      port.postMessage(bindings.handle(m));
      return;
    }
    chain = chain.then(async () => {
      if (m.type === 'config') await apply(m.config);
      else if (m.type === 'stop') {
        gw?.stop();
        gw = null;
        listenKey = '';
        port.postMessage({ type: 'stopped' });
      }
    });
  });
}
