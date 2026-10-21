/**
 * 旧版「编程助手第三方供应商」存储（userData/cli-providers/<cli>/store.json）的 Key 解密。
 * 旧功能已由统一网关取代，只剩一次性迁移和撤销旧全局配置（gateway/migrate.ts、revokeLegacy.ts）还要读它。
 */
import { safeStorage } from 'electron';

export function decryptLegacyCliKey(enc: string): string {
  if (!enc) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
  } catch {
    /* 退回明文 base64 */
  }
  try {
    return Buffer.from(enc, 'base64').toString('utf8');
  } catch {
    return '';
  }
}
