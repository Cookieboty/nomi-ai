/**
 * 旧版「编程助手第三方供应商」存储（userData/cli-providers/<cli>/store.json）的 Key 解密。
 * 旧功能已由统一网关取代，只剩一次性迁移和撤销旧全局配置（gateway/migrate.ts、revokeLegacy.ts）还要读它。
 *
 * 不依赖 Electron：系统安全存储经宿主的 secrets 端口（Electron 下是 safeStorage）。
 */
import type { SecretsPort } from '@nomi-ai/host-ports';

/** 生成解密函数：先试安全存储，不可用或失败时按明文 base64 读（旧格式没有加密标记） */
export function legacyCliKeyDecryptor(
  secrets: Pick<SecretsPort, 'available' | 'decrypt'>,
): (enc: string) => string {
  return (enc) => {
    if (!enc) return '';
    try {
      if (secrets.available()) {
        return secrets.decrypt(Buffer.from(enc, 'base64'));
      }
    } catch {
      /* 退回明文 base64 */
    }
    try {
      return Buffer.from(enc, 'base64').toString('utf8');
    } catch {
      return '';
    }
  };
}
