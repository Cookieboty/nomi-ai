/**
 * 无界面 e2e 的进程环境（每个用例文件一次）：内核会读用户目录下的编程助手配置 / 会话日志、在 PATH 里找
 * CLI、起离线 TTS 与首次引导。全部指到空目录或关掉，不碰开发机，结果也不随本机装了什么而变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-e2e-home-'));
const saved: Record<string, string | undefined> = {};
const env: Record<string, string> = {
  HOME: home,
  USERPROFILE: home,
  PATH: path.dirname(process.execPath),
  CD_TTS: 'off',
  CD_ONBOARDING: 'off',
  CD_LOCALE: 'zh-CN',
  NOMI_HARNESS_PREWARM: '0',
};
for (const [k, v] of Object.entries(env)) {
  saved[k] = process.env[k];
  process.env[k] = v;
}
// 环境变量里的供应商 Key 会让内核注册真实的云端 provider：e2e 只用假 LLM
for (const k of Object.keys(process.env)) {
  if (/_API_KEY$|_BASE_URL$/.test(k) || k === 'NOMI_PROVIDER' || k === 'MCP_SERVERS') {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});
