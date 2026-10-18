/**
 * 跨平台列出本机编程助手进程（只读，不注入、不附加）。
 * - macOS / Linux：`ps -A -o pid=,comm=,args=`；Linux 读 /proc/<pid>/cwd，macOS 用 `lsof -d cwd`
 * - Windows：PowerShell `Get-CimInstance Win32_Process`（带命令行；拿不到 cwd）
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';

import type { AgentKind } from './parsers';

export interface AgentProc {
  pid: number;
  kind: AgentKind;
  /** 工作目录（能拿到时） */
  cwd?: string;
}

export interface RawProc {
  pid: number;
  name: string;
  cmd: string;
}

const RULES: Array<{ kind: AgentKind; test: (name: string, cmd: string) => boolean }> = [
  {
    kind: 'claude',
    test: (n, c) =>
      // 排除 Claude 桌面版（Claude.app / Claude Helper / AnthropicClaude）
      !/Claude\.app|Claude Helper|AnthropicClaude|claude-desktop/i.test(c) &&
      (/^claude(\.exe)?$/i.test(n) ||
        /@anthropic-ai[\\/]claude-code/i.test(c) ||
        /(^|[\\/\s])claude(\.exe)?(\s|$)/i.test(c)),
  },
  {
    kind: 'codex',
    test: (n, c) =>
      !/Codex\.app/i.test(c) &&
      (/^codex(\.exe)?$/i.test(n) ||
        /@openai[\\/]codex/i.test(c) ||
        /(^|[\\/\s])codex(-[a-z0-9_-]+)?(\.exe)?(\s|$)/i.test(c)),
  },
  {
    kind: 'cursor',
    test: (n, c) =>
      /cursor-agent/i.test(c) ||
      /^cursor-agent/i.test(n) ||
      // Cursor IDE 主进程（不算 helper / renderer）
      (/^cursor(\.exe)?$/i.test(n) && !/--type=/.test(c)),
  },
  {
    kind: 'aider',
    test: (n, c) =>
      /^aider(\.exe)?$/i.test(n) || /(^|[\\/\s])aider(\.exe)?(\s|$)|-m aider\b/i.test(c),
  },
  {
    kind: 'gemini',
    test: (n, c) =>
      /^gemini(\.exe)?$/i.test(n) ||
      /@google[\\/]gemini-cli/i.test(c) ||
      /(^|[\\/\s])gemini(\.exe)?(\s|$)/i.test(c),
  },
  {
    kind: 'dsh',
    test: (n, c) =>
      /^dsh(\.exe)?$/i.test(n) ||
      /@deepseek-ai[\\/]dsh[\\/]/i.test(c) ||
      /(^|[\\/\s])dsh(\.exe)?(\s|$)/i.test(c),
  },
  {
    kind: 'grok',
    test: (n, c) =>
      /^grok(\.exe)?$/i.test(n) ||
      /@xai-official[\\/]grok/i.test(c) ||
      /(^|[\\/\s])grok(\.exe)?(\s|$)/i.test(c),
  },
  { kind: 'cline', test: (n, c) => /^cline(\.exe)?$/i.test(n) || /[\\/]cline[\\/].*cli/i.test(c) },
];

export function classify(procs: RawProc[], selfPid = process.pid): AgentProc[] {
  const out: AgentProc[] = [];
  for (const p of procs) {
    if (p.pid === selfPid) continue;
    // 我们自己的 ps / grep / 编辑器打开同名文件不算
    if (/^(ps|grep|rg|lsof|tasklist)(\.exe)?$/i.test(p.name)) continue;
    const r = RULES.find((x) => x.test(p.name, p.cmd));
    if (r) out.push({ pid: p.pid, kind: r.kind });
  }
  return out;
}

export function parsePs(stdout: string): RawProc[] {
  const out: RawProc[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[2].split('/').pop() ?? m[2];
    out.push({ pid: Number(m[1]), name, cmd: m[3] || m[2] });
  }
  return out;
}

export function parseWinJson(stdout: string): RawProc[] {
  try {
    const v = JSON.parse(stdout) as unknown;
    const arr = (Array.isArray(v) ? v : [v]) as Array<Record<string, unknown>>;
    return arr
      .filter((x) => x && typeof x.ProcessId === 'number')
      .map((x) => ({
        pid: x.ProcessId as number,
        name: String(x.Name ?? '').replace(/\.exe$/i, ''),
        cmd: String(x.CommandLine ?? x.Name ?? ''),
      }));
  } catch {
    return [];
  }
}

function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (e, so) =>
      e ? reject(e) : resolve(String(so)),
    );
  });
}

async function cwdsMac(pids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (!pids.length) return m;
  try {
    const so = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']);
    let pid = 0;
    for (const l of so.split('\n')) {
      if (l.startsWith('p')) pid = Number(l.slice(1));
      else if (l.startsWith('n') && pid) m.set(pid, l.slice(1));
    }
  } catch {
    /* lsof 不可用：不给 cwd */
  }
  return m;
}

/** 列出编程助手进程；整体失败返回 null（调用方视为「无法判断」） */
export async function listAgentProcesses(platform = process.platform): Promise<AgentProc[] | null> {
  try {
    if (platform === 'win32') {
      const so = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
        ],
        8000,
      );
      return classify(parseWinJson(so));
    }
    const so = await run('ps', ['-A', '-o', 'pid=,comm=,args=']);
    const found = classify(parsePs(so));
    if (platform === 'linux') {
      for (const p of found) {
        try {
          p.cwd = fs.readlinkSync(`/proc/${p.pid}/cwd`);
        } catch {
          /* 别的用户的进程 */
        }
      }
    } else if (platform === 'darwin') {
      const cw = await cwdsMac(found.map((p) => p.pid));
      for (const p of found) p.cwd = cw.get(p.pid);
    }
    return found;
  } catch {
    return null;
  }
}

/**
 * Linux：/proc/locks 里被持有的文件 inode（dsh 用 flock 锁 session.lock）。
 * 其它平台无法廉价判断，返回 null。
 */
export function readLockedInodes(platform: NodeJS.Platform = process.platform): Set<number> | null {
  if (platform !== 'linux') return null;
  try {
    return parseProcLocks(fs.readFileSync('/proc/locks', 'utf8'));
  } catch {
    return null;
  }
}

export function parseProcLocks(raw: string): Set<number> {
  const out = new Set<number>();
  for (const line of raw.split('\n')) {
    // 1: FLOCK  ADVISORY  WRITE 103198 00:2f:1680557 0 EOF
    const m = /\s(?:[0-9a-f]+):(?:[0-9a-f]+):(\d+)\s/i.exec(line);
    if (m && /FLOCK|POSIX|OFDLCK/.test(line)) out.add(Number(m[1]));
  }
  return out;
}
