import { protocol } from 'electron';

import { CHARACTER_PACK_SCHEME_PRIVILEGES } from './character/packProtocol';
import { CHAT_ASSET_SCHEME_PRIVILEGES } from './host/assetProtocol';

/**
 * 必须在 app ready 之前调用，且**只能调用一次**：
 * `protocol.registerSchemesAsPrivileged` 每次调用都会整体替换已注册的特权列表，
 * 分多次注册会让先注册的协议失去 fetch / CORS 能力。新增自定义协议请加进这一次调用里。
 */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    CHAT_ASSET_SCHEME_PRIVILEGES,
    CHARACTER_PACK_SCHEME_PRIVILEGES,
  ]);
}
