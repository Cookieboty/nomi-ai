/**
 * 凭据（CalDAV 密码、云 TTS Key、MCP env / header 密钥）的加密落盘封装。
 *
 * 系统安全存储（Electron safeStorage）不可用、或加密抛错时 **失败关闭**：
 * 抛 SecretStorageUnavailableError，调用方拒绝保存，绝不静默降级成明文。
 * 读取仍兼容旧版本留下的明文（不带 `enc:` 前缀的值）。
 */
import { safeStorage } from 'electron';

export class SecretStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStorageUnavailableError';
  }
}

/** 当前是否能把一个值安全加密（含一次真实加密探测，覆盖 encryptString 抛错的情况） */
export function canEncryptSecrets(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    safeStorage.encryptString('nomi-probe');
    return true;
  } catch {
    return false;
  }
}

/** 返回 `enc:<base64>`；不可用或失败时抛 SecretStorageUnavailableError(message) */
export function encryptSecret(value: string, unavailableMessage: string): string {
  try {
    if (safeStorage.isEncryptionAvailable())
      return `enc:${safeStorage.encryptString(value).toString('base64')}`;
  } catch {
    /* 落到下面统一抛错 */
  }
  throw new SecretStorageUnavailableError(unavailableMessage);
}

/** 解密 `enc:` 值；无前缀视为旧版明文原样返回；解密失败返回空串 */
export function decryptSecret(value: string | undefined): string {
  if (!value) return '';
  if (!value.startsWith('enc:')) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  } catch {
    return '';
  }
}
