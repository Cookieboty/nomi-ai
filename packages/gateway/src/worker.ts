/**
 * 网关进程的消息循环（docs/design/unified-gateway.md §5.3）。
 * 主进程（GatewayService）通过 utilityProcess 的 parentPort 推送配置快照；网关回报监听地址、用量与错误。
 * 这里不依赖 Electron：port 只要有 on('message') / postMessage 即可，单测用假的 port。
 */
import type { GatewayConfig } from './config';
import { createGateway, type GatewayHooks, type GatewayServer, type UsageEvent } from './server';

export type WorkerInbound = { type: 'config'; config: GatewayConfig } | { type: 'stop' };

export type WorkerOutbound =
  | { type: 'listening'; port: number; url: string }
  | { type: 'usage'; event: UsageEvent }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'stopped' };

export interface WorkerPort {
  on(ev: 'message', fn: (e: { data: WorkerInbound }) => void): void;
  postMessage(m: WorkerOutbound): void;
}

export function runGatewayWorker(
  port: WorkerPort,
  hooks: Omit<GatewayHooks, 'onUsage'> = {},
): void {
  let gw: GatewayServer | null = null;
  let listenKey = '';
  // 串行处理消息：启动是异步的，后到的配置要等前一次完成
  let chain = Promise.resolve();

  const apply = async (config: GatewayConfig) => {
    const key = `${config.host}:${config.port}`;
    if (gw && key === listenKey) {
      gw.update(config);
      return;
    }
    gw?.stop();
    gw = createGateway(config, {
      ...hooks,
      onUsage: (event) => port.postMessage({ type: 'usage', event }),
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
