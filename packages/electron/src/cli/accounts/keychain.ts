/**
 * macOS 钥匙串 generic password（Claude Code 在 macOS 上的凭据存储）。
 * S7：Nomi 只在删除账号 / 登录前清理时 `remove`，绝不 get/set 凭据内容。
 * 旧的 get/set API 已硬弃用（调用即抛错），防止被重新接上。
 */
import { execFile } from 'node:child_process';

export interface KeychainAdapter {
  /** @deprecated S7：已移除，调用即抛错 */
  get(service: string, account: string): Promise<string | null>;
  /** @deprecated S7：已移除，调用即抛错 */
  set(service: string, account: string, value: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}

const dead = (op: string) => (): Promise<never> =>
  Promise.reject(new Error(`keychain.${op} removed (S7: Nomi must not read/write credentials)`));

export const macKeychain: KeychainAdapter = {
  get: dead('get'),
  set: dead('set'),
  remove(service, account) {
    return new Promise((resolve) => {
      execFile(
        '/usr/bin/security',
        ['delete-generic-password', '-s', service, '-a', account],
        { timeout: 10_000 },
        () => resolve(),
      );
    });
  },
};
