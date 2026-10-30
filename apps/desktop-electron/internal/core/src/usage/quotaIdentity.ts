/**
 * 账号身份指纹：只用来判断「是不是换了号」，不是凭据。
 * sha256(随机盐 + 字段)，取前 16 位十六进制；盐是本机随机生成的，存在 userData/usage 里（0600），
 * 邮箱 / 账号 id 的明文既不落盘也不进日志，指纹也无法被反推。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFile } from '../utils/privateFile';

const SALT_FILE = 'quota-salt';

export function loadSalt(root: string): string {
  const f = path.join(root, SALT_FILE);
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(s)) return s;
  } catch {
    /* 第一次 */
  }
  const salt = randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(root, { recursive: true });
    writePrivateFile(f, salt);
  } catch {
    /* 写不了就只在本次进程内有效 */
  }
  return salt;
}

/** 空字段整体视为「没有身份」（返回 null）：不会把不同账号误判成同一个 */
export function fingerprint(salt: string, parts: Array<string | null | undefined>): string | null {
  const vals = parts.map((p) => (typeof p === 'string' ? p.trim() : ''));
  if (!vals[0]) return null;
  return createHash('sha256')
    .update(`${salt}\n${JSON.stringify(vals)}`)
    .digest('hex')
    .slice(0, 16);
}
