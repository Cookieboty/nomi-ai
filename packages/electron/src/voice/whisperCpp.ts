/**
 * whisper.cpp 本地识别：whisper-cli -m <model> -f <wav> -nt -np -l <lang>。
 * 二进制来源：按需下载的官方包（Windows / Linux）、PATH 中的 whisper-cli（如 macOS `brew install whisper-cpp`）、或用户指定路径。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { t } from '../i18n';

export const CLI_NAMES =
  process.platform === 'win32' ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli', 'main'];

export function findCliIn(dir: string, names = CLI_NAMES): string | null {
  for (const n of names) {
    for (const p of [path.join(dir, n), path.join(dir, 'Release', n), path.join(dir, 'bin', n)]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function findCliOnPath(env = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  // macOS Homebrew 默认目录不一定在 GUI 应用的 PATH 里
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const d of dirs) {
    const p = path.join(d, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function buildArgs(o: {
  model: string;
  wav: string;
  language: string;
  prompt?: string;
  threads?: number;
}): string[] {
  const args = ['-m', o.model, '-f', o.wav, '-nt', '-np', '-l', o.language || 'auto'];
  args.push('-t', String(o.threads ?? Math.max(1, Math.min(8, os.cpus().length - 1))));
  if (o.prompt) args.push('--prompt', o.prompt);
  return args;
}

/** 清理 whisper 输出：去掉 [BLANK_AUDIO] / (音乐) 等标注与多余空白 */
export function cleanTranscript(s: string): string {
  return s
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SOUND|silence)[^\]]*\]/gi, '')
    .replace(
      /[([（*]\s*(音乐|掌声|笑声|笑|叹气|music|applause|laughter|laughs?|sighs?|coughs?|inaudible|silence|noise)\s*[)\]）*]/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export async function runWhisperCli(o: {
  cli: string;
  model: string;
  wav: Uint8Array;
  language: string;
  prompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-asr-'));
  const wavPath = path.join(dir, 'in.wav');
  fs.writeFileSync(wavPath, o.wav);
  const cliDir = path.dirname(o.cli);
  const env = { ...process.env };
  if (process.platform === 'linux')
    env.LD_LIBRARY_PATH = [cliDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        o.cli,
        buildArgs({ model: o.model, wav: wavPath, language: o.language, prompt: o.prompt }),
        {
          cwd: cliDir,
          env,
          timeout: o.timeoutMs ?? 120_000,
          signal: o.signal,
          maxBuffer: 8 << 20,
          windowsHide: true,
        },
        (err, stdout, stderr) =>
          err
            ? reject(
                new Error(
                  t('electron.common.whisper-cpp-failed', (stderr || err.message).slice(-300)),
                ),
              )
            : resolve(stdout),
      );
    });
    return cleanTranscript(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
