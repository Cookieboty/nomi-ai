/**
 * 凭据（CalDAV 密码、云 TTS Key、MCP env / header 密钥）的加密落盘封装。
 *
 * 字节级加解密走宿主的 `secrets` 端口（Electron：safeStorage）；`enc:` 前缀、失败关闭、
 * 旧明文兼容这些策略留在这里（docs/design/core-host-decoupling.md §6.3）。
 *
 * 系统安全存储不可用、或加密抛错时 **失败关闭**：抛 SecretStorageUnavailableError，
 * 调用方拒绝保存，绝不静默降级成明文。读取仍兼容旧版本留下的明文（不带 `enc:` 前缀的值）。
 */
import type { SafeStorageLike } from '@nomi-ai/ai-runtime';
import type { SecretsPort } from '@nomi-ai/host-ports';

export class SecretStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStorageUnavailableError';
  }
}

/** 加解密只用到端口的这三个方法 */
export type SecretBoxPort = Pick<SecretsPort, 'available' | 'encrypt' | 'decrypt'>;

export interface SecretBox {
  /** 当前是否能把一个值安全加密（含一次真实加密探测，覆盖 encrypt 抛错的情况） */
  canEncrypt(): boolean;
  /** 返回 `enc:<base64>`；不可用或失败时抛 SecretStorageUnavailableError(message) */
  encrypt(value: string, unavailableMessage: string): string;
  /** 解密 `enc:` 值；无前缀视为旧版明文原样返回；解密失败返回空串 */
  decrypt(value: string | undefined): string;
}

export function createSecretBox(secrets: SecretBoxPort): SecretBox {
  return {
    canEncrypt() {
      try {
        if (!secrets.available()) return false;
        secrets.encrypt('nomi-probe');
        return true;
      } catch {
        return false;
      }
    },
    encrypt(value, unavailableMessage) {
      try {
        if (secrets.available())
          return `enc:${Buffer.from(secrets.encrypt(value)).toString('base64')}`;
      } catch {
        /* 落到下面统一抛错 */
      }
      throw new SecretStorageUnavailableError(unavailableMessage);
    },
    decrypt(value) {
      if (!value) return '';
      if (!value.startsWith('enc:')) return value;
      try {
        return secrets.decrypt(Buffer.from(value.slice(4), 'base64'));
      } catch {
        return '';
      }
    },
  };
}

/**
 * 把 `secrets` 端口适配成 ai-runtime 的 `SafeStorageLike`（`createSafeStorageCipher` 用它判定
 * 可用性与 Linux 的 `basic_text` 后端）。
 */
export function safeStorageFromSecrets(secrets: SecretsPort): SafeStorageLike {
  return {
    isEncryptionAvailable: () => secrets.available(),
    // 平台不提供后端名时给空串：不是 `basic_text` / `unknown`，不影响判定
    getSelectedStorageBackend: () => secrets.backend() ?? '',
    encryptString: (plain) => Buffer.from(secrets.encrypt(plain)),
    decryptString: (buf) => secrets.decrypt(buf),
  };
}
