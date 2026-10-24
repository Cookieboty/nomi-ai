/**
 * ACP 试运行（「添加 CLI」的「测试」按钮）：只做 initialize 握手，读出 CLI 报告的身份与能力，然后结束进程。
 * 不建会话、不发 prompt，所以不会让 CLI 做任何事。
 */
import { endChild, type ChildLike, type KillFn } from '../child';
import { JsonRpcConnection, type Json } from '../rpc/jsonrpc';

export interface AcpProbeResult {
  /** CLI 报告的协议版本 */
  protocolVersion: number | null;
  /** agentInfo（名字 / 版本），CLI 没报告时为空 */
  agent: { name?: string; title?: string; version?: string };
  capabilities: {
    loadSession: boolean;
    images: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
  /** 登录方式的名字（只取名字，不取任何说明里的链接参数） */
  authMethods: string[];
}

const str = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined;

export async function probeAcp(
  child: ChildLike,
  o: { timeoutMs?: number; kill?: KillFn } = {},
): Promise<AcpProbeResult> {
  const conn = new JsonRpcConnection(child, {
    onNotification: () => undefined,
    // 握手阶段 CLI 不该向我们要东西；一律拒绝（不读写文件、不批准权限）
    onRequest: () => Promise.reject(new Error('not supported during probe')),
  });
  try {
    const init = await conn.request<{
      protocolVersion?: unknown;
      agentCapabilities?: Json;
      agentInfo?: Json;
      authMethods?: unknown;
    } | null>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
      { timeoutMs: o.timeoutMs ?? 15_000 },
    );
    const caps = (init?.agentCapabilities ?? {}) as Json;
    const prompt = (caps.promptCapabilities ?? {}) as Json;
    const info = (init?.agentInfo ?? {}) as Json;
    const agent: AcpProbeResult['agent'] = {};
    for (const k of ['name', 'title', 'version'] as const) {
      const v = str(info[k]);
      if (v) agent[k] = v;
    }
    return {
      protocolVersion: typeof init?.protocolVersion === 'number' ? init.protocolVersion : null,
      agent,
      capabilities: {
        loadSession: caps.loadSession === true,
        images: prompt.image === true,
        audio: prompt.audio === true,
        embeddedContext: prompt.embeddedContext === true,
      },
      authMethods: Array.isArray(init?.authMethods)
        ? (init.authMethods as Json[])
            .map((m) => str(m?.name) ?? str(m?.id))
            .filter((x): x is string => !!x)
            .slice(0, 8)
        : [],
    };
  } finally {
    endChild(child, o.kill);
  }
}
