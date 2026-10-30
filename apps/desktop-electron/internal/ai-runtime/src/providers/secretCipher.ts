/**
 * Token 加密：Electron `safeStorage`（macOS Keychain / Windows DPAPI / Linux libsecret|kwallet）。
 *
 * safeStorage 不可用时（如 Linux 无 keyring、`--password-store=basic`）回退到
 * `plaintextCipher`：仅 base64 编码、**不是加密**——store 会把 `encryption: 'none'`
 * 暴露给 UI，面板据此显示明确警告。
 */
export interface SecretCipher {
  /** 'safeStorage' = 系统级加密；'none' = 未加密回退 */
  readonly kind: 'safeStorage' | 'none';
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export const plaintextCipher: SecretCipher = {
  kind: 'none',
  encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
  decrypt: (stored) => Buffer.from(stored, 'base64').toString('utf8'),
};

/**
 * Linux 下 safeStorage 可能选中 `basic_text`（固定口令，等同明文）；视为不可用。
 */
export function createSafeStorageCipher(safeStorage: SafeStorageLike | undefined): SecretCipher {
  if (!safeStorage) return plaintextCipher;
  let available: boolean;
  try {
    available = safeStorage.isEncryptionAvailable();
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (backend === 'basic_text' || backend === 'unknown') available = false;
  } catch {
    available = false;
  }
  if (!available) return plaintextCipher;
  return {
    kind: 'safeStorage',
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
  };
}

/** 掩码显示：`sk-abc…wxyz`；短 key 只保留末 2 位。永远不返回完整明文。 */
export function maskSecret(secret: string): string {
  const s = secret.trim();
  if (s.length <= 8) return `${'•'.repeat(Math.max(s.length - 2, 1))}${s.slice(-2)}`;
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}
