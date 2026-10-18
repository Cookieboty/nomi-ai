import { protocol } from 'electron';

import { CHAT_ASSET_SCHEME_PRIVILEGES } from './chat/assetProtocol';
import { MODEL_SCHEME_PRIVILEGES } from './models/ModelService';

/**
 * 必须在 app ready 之前调用，且**只能调用一次**：
 * `protocol.registerSchemesAsPrivileged` 每次调用都会整体替换已注册的特权列表，
 * 分多次注册（cdmodel:// 一次、chat-asset:// 一次）会让先注册的协议失去 fetch / CORS 能力，
 * 表现为 VRM 加载失败（"URL scheme \"cdmodel\" is not supported"）。新增自定义协议请加进这里。
 */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([MODEL_SCHEME_PRIVILEGES, CHAT_ASSET_SCHEME_PRIVILEGES]);
}
