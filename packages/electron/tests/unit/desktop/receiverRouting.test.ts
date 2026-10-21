/**
 * 回归 #17：文件 / 知识库 / 摘要 / 屏幕记忆等工具的「仅本地」与「云端首次同意」校验，
 * 必须针对工具结果的实际接收者（跑本轮工具循环的 provider，ctx.provider），而不是按角色猜。
 *
 * 混合路由：chat = 云端、agent-tools / summary = 本地。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

jest.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: {},
  shell: {},
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn(), on: jest.fn() },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AppTrash } from '../../../src/desktop/AppTrash';
import { AuditLog } from '../../../src/desktop/AuditLog';
import { DesktopService } from '../../../src/desktop/DesktopService';
import { parseFile } from '../../../src/desktop/parse/runParse';
import { PermissionBroker, type ConfirmRequest } from '../../../src/desktop/PermissionBroker';
import { createDesktopTools, type ProviderInfo } from '../../../src/desktop/tools';
import { UndoJournal } from '../../../src/desktop/UndoJournal';
import { KnowledgeService } from '../../../src/knowledge/KnowledgeService';

type Role = 'chat' | 'agent-tools' | 'summary';
type R = { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };

const CLOUD: ProviderInfo = { id: 'p-cloud', name: 'CloudCo', local: false };
const LOCAL: ProviderInfo = { id: 'p-local', name: 'Ollama', local: true };
const CLOUD_CTX = { id: 'p-cloud', baseURL: 'https://api.cloudco.example/v1' };
const LOCAL_CTX = { id: 'p-local', baseURL: 'http://127.0.0.1:11434/v1' };
const known = (id: string) =>
  id === 'p-cloud'
    ? { id, name: 'CloudCo', baseURL: CLOUD_CTX.baseURL }
    : id === 'p-local'
      ? { id, name: 'Ollama', baseURL: LOCAL_CTX.baseURL }
      : null;

function setup(routes: Record<Role, ProviderInfo>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'route-')));
  const docs = path.join(root, 'docs');
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, 'secret.md'), 'TOP SECRET LOCAL FILE BODY');
  const data = path.join(root, 'data');
  const broker = new PermissionBroker(
    path.join(data, 'settings.json'),
    {
      home: root,
      platform: process.platform,
      realpath: (p) => fs.promises.realpath(p),
      denyRoots: [data],
    },
    { timeoutMs: 2000 },
  );
  broker.grant(docs, 'read');
  const asks: ConfirmRequest[] = [];
  let answer = true;
  broker.ui = {
    request: (r) => {
      asks.push(r);
      setTimeout(() => broker.answer(r.id, answer), 0);
    },
    cancel: () => undefined,
  };
  const summarized: string[] = [];
  const current = { ...routes };
  const tools = createDesktopTools({
    broker,
    audit: new AuditLog(path.join(data, 'audit')),
    journal: new UndoJournal(path.join(data, 'journal.jsonl'), new AppTrash(path.join(data, 'tr'))),
    trash: new AppTrash(path.join(data, 'trash')),
    parse: (p) => parseFile(p),
    summarize: async (text) => {
      summarized.push(text);
      return `SUMMARY(${text.length})`;
    },
    providerFor: (r) => current[r],
    describeProvider: (p) => {
      const k = known(p.id);
      return {
        id: p.id,
        name: k?.name ?? p.id,
        local: /127\.0\.0\.1|localhost/.test(p.baseURL ?? ''),
      };
    },
    pickFolder: async () => null,
  });
  const call = async (name: string, input: unknown, provider?: { id: string; baseURL?: string }) =>
    (await tools.find((t) => t.name === name)!.execute(input, provider ? { provider } : {})) as R;
  return {
    docs,
    broker,
    asks,
    summarized,
    call,
    route: (r: Role, p: ProviderInfo) => (current[r] = p),
    setAnswer: (a: boolean) => (answer = a),
  };
}

const MIXED: Record<Role, ProviderInfo> = { chat: CLOUD, 'agent-tools': LOCAL, summary: LOCAL };

describe('工具按实际接收者校验（#17）', () => {
  it('localOnly + 云端 chat 实际接收：fs_read_text / fs_summarize 都失败，文件正文没有返回', async () => {
    const t = setup(MIXED);
    t.broker.setLocalOnly(true);
    const f = path.join(t.docs, 'secret.md');
    const read = await t.call('fs_read_text', { path: f }, CLOUD_CTX);
    expect(read.error?.code).toBe('local_only');
    expect(JSON.stringify(read)).not.toContain('TOP SECRET');
    const sum = await t.call('fs_summarize', { path: f }, CLOUD_CTX);
    expect(sum.error?.code).toBe('local_only');
    expect(t.summarized).toEqual([]); // 连本地摘要模型都没跑
  });

  it('缺失实际 provider（非 LLM 循环调用）：失败关闭，只要候选里有云端就拒绝', async () => {
    const t = setup(MIXED);
    t.broker.setLocalOnly(true);
    const f = path.join(t.docs, 'secret.md');
    expect((await t.call('fs_read_text', { path: f })).error?.code).toBe('local_only');
    expect((await t.call('fs_summarize', { path: f })).error?.code).toBe('local_only');
  });

  it('反向配置（chat 本地、agent-tools 云端）：实际接收者是本地时正常执行，不被误拦', async () => {
    const t = setup({ chat: LOCAL, 'agent-tools': CLOUD, summary: LOCAL });
    t.broker.setLocalOnly(true);
    const f = path.join(t.docs, 'secret.md');
    const r = await t.call('fs_read_text', { path: f }, LOCAL_CTX);
    expect(r.ok).toBe(true);
    expect(String(r.data!.text)).toContain('TOP SECRET');
    expect((await t.call('fs_summarize', { path: f }, LOCAL_CTX)).ok).toBe(true);
  });

  it('未开 localOnly：首次同意针对实际接收的云端 provider，而不是 agent-tools 的本地 provider', async () => {
    const t = setup(MIXED);
    const f = path.join(t.docs, 'secret.md');
    const r = await t.call('fs_read_text', { path: f }, CLOUD_CTX);
    expect(r.ok).toBe(true);
    const notice = t.asks.find((a) => a.tool === 'cloud_send_notice');
    expect(notice?.summary).toContain('CloudCo');
    expect(t.broker.view().cloudAcked).toEqual(['p-cloud']);
    // 第二次不再询问
    const before = t.asks.length;
    await t.call('fs_read_text', { path: f }, CLOUD_CTX);
    expect(t.asks.length).toBe(before);
  });

  it('用户拒绝云端同意：失败且不返回内容', async () => {
    const t = setup(MIXED);
    t.setAnswer(false);
    const r = await t.call('fs_read_text', { path: path.join(t.docs, 'secret.md') }, CLOUD_CTX);
    expect(r.error?.code).toBe('user_denied');
  });

  it('运行中路由变更不影响：校验的是本轮循环启动时的 provider', async () => {
    const t = setup(MIXED);
    t.broker.setLocalOnly(true);
    const f = path.join(t.docs, 'secret.md');
    t.route('chat', LOCAL); // 面板里把 chat 改成了本地……
    t.route('agent-tools', LOCAL);
    // ……但这一轮循环仍然是云端 provider 在接收结果
    expect((await t.call('fs_read_text', { path: f }, CLOUD_CTX)).error?.code).toBe('local_only');
  });
});

describe('知识库 kb_search（#17）', () => {
  function kb(routes: Record<Role, ProviderInfo>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-route-'));
    const desktop = new DesktopService(path.join(root, 'desktop'), {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as never);
    desktop.attachRuntime({
      complete: async () => '',
      resolveProvider: (r) => ({
        id: routes[r].id,
        name: routes[r].name,
        baseURL: routes[r].local ? LOCAL_CTX.baseURL : CLOUD_CTX.baseURL,
      }),
      lookupProvider: known,
    });
    const svc = new KnowledgeService({
      root: path.join(root, 'kb'),
      logger: { info() {}, warn() {}, error() {} } as never,
      desktop,
      listProviders: () => [],
      credentials: () => null,
      chatProvider: () => null,
      complete: async () => '',
    } as never);
    const search = jest.spyOn(svc as never, 'search' as never).mockResolvedValue({
      hits: [{ title: 'doc', text: 'KB SNIPPET', path: '/x' }],
      mode: 'keyword',
    } as never);
    const tool = svc.tools().find((x) => x.name === 'kb_search')!;
    return { desktop, search, tool };
  }

  it('localOnly + 云端 chat 实际接收：kb_search 失败且没有执行检索', async () => {
    const k = kb(MIXED);
    k.desktop.broker.setLocalOnly(true);
    const r = (await k.tool.execute({ query: 'x' }, { provider: CLOUD_CTX })) as R;
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('local_only');
    expect(k.search).not.toHaveBeenCalled();
  });

  it('缺失 provider 同样失败关闭；反向配置下本地接收者可用', async () => {
    const k = kb(MIXED);
    k.desktop.broker.setLocalOnly(true);
    expect(((await k.tool.execute({ query: 'x' }, {})) as R).error?.code).toBe('local_only');
    const ok = (await k.tool.execute({ query: 'x' }, { provider: LOCAL_CTX })) as R;
    expect(ok.ok).toBe(true);
    expect(k.search).toHaveBeenCalledTimes(1);
  });
});
