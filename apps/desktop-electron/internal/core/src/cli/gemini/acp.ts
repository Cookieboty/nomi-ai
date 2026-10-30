/**
 * ACP / app-server 的 JSON-RPC 传输：实现已搬到 @nomi-ai/cli-sdk（`JsonRpcConnection`，
 * docs/design/cli-plugin-architecture.md §5.4）。这里只补上本地化的超时文案并保留旧名字，
 * 账号登录、模型发现等仍按旧名字使用。
 */
import {
  JsonRpcConnection,
  RPC_REQUEST_TIMEOUT_MS,
  type ChildLike,
  type RpcHandlers,
  type RpcRequestOptions,
} from '@nomi-ai/cli-sdk';

import { t } from '../../i18n';

export {
  RpcError as AcpError,
  RpcTimeoutError as AcpTimeoutError,
  innermostMessage,
} from '@nomi-ai/cli-sdk';

/** 普通请求（initialize / session/new …）默认等多久 */
export const ACP_REQUEST_TIMEOUT_MS = RPC_REQUEST_TIMEOUT_MS;

export type AcpRequestOptions = RpcRequestOptions;

/** 超时错误的文案（驱动与连接共用） */
export const acpTimeoutMessage = (_method: string, timeoutMs: number) =>
  t('electron.common.gemini-did-not-respond-for-seconds-so-the', Math.round(timeoutMs / 1000));

export class AcpConnection extends JsonRpcConnection {
  constructor(child: ChildLike, handlers: RpcHandlers) {
    super(child, handlers, { timeoutMessage: acpTimeoutMessage });
  }
}
