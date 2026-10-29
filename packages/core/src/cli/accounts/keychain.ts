/**
 * macOS 钥匙串 generic password（Claude Code 在 macOS 上的凭据存储）。
 * S7：Nomi 只在删除账号 / 登录前清理时 `remove`，绝不 get/set 凭据内容。
 */
import { execFile } from 'node:child_process';

export interface KeychainAdapter {
  remove(service: string, account: string): Promise<void>;
}

export const macKeychain: KeychainAdapter = {
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
