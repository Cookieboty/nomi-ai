/**
 * 网关子进程入口（Electron utilityProcess，docs/design/unified-gateway.md §5.3）。
 * 逻辑都在 @nomi-ai/gateway 里（纯 Node）；这里只把 parentPort 交给它。
 * 不读写磁盘上的密钥：配置快照（含已解密的 Key）由主进程推送，只在内存里。
 */
import { runGatewayWorker, type WorkerPort } from '@nomi-ai/gateway';

const port = (process as unknown as { parentPort?: WorkerPort }).parentPort;
if (port) runGatewayWorker(port);
