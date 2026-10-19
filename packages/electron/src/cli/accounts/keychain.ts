/**
 * macOS 钥匙串 generic password（Claude Code 在 macOS 上的凭据存储）。
 * 与 Claude Code 一样经 `security` 读写：同一个工具创建 / 读取，不会额外弹出授权。
 * 写入经 `security -i` 从 stdin 传十六进制，凭据不出现在进程参数里（`ps` 看不到）。
 */
import { execFile, spawn } from 'node:child_process';

export interface KeychainAdapter {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}

/** 钥匙串命令参数里的服务名 / 账户名只允许这些字符（防注入 `security -i` 的命令行） */
const SAFE = /^[\w .@+-]+$/;

export const macKeychain: KeychainAdapter = {
  get(service, account) {
    return new Promise((resolve) => {
      execFile(
        '/usr/bin/security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout).replace(/\n$/, '') || null),
      );
    });
  },
  set(service, account, value) {
    if (!SAFE.test(service) || !SAFE.test(account))
      return Promise.reject(new Error('bad keychain name'));
    const hex = Buffer.from(value, 'utf8').toString('hex');
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.trim() || `security exited ${code}`)),
      );
      child.stdin.end(`add-generic-password -U -s "${service}" -a "${account}" -X ${hex}\n`);
    });
  },
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
