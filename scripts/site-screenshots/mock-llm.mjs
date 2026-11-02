// 官网截图用的模拟模型：OpenAI 兼容（/v1/models、/v1/chat/completions，流式与非流式），
// 按用户最后一句话里的关键词返回写好的演示回复。只监听 127.0.0.1，不联网。
import http from 'node:http';

export const DEMO_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

/** 关键词 → 回复。场景（scenes.mjs）里发的话要能命中这里，截图内容才稳定。 */
const SCRIPTS = [
  [
    /待办|to-?do/i,
    '好的～今天的待办我帮你理了一下：\n\n1. **上午**：回复两封客户邮件\n2. **下午 3 点**：产品评审会，我会提前 10 分钟提醒你\n3. **晚上**：整理会议笔记并发给团队\n\n要不要我把第 3 项设成明天上午的提醒？',
  ],
  [
    /周报|weekly/i,
    '周报草稿写好了，按「本周完成 / 下周计划 / 风险」三段整理：\n\n**本周完成**\n- 登录页报错修复并上线\n- 统一网关支持 Gemini 协议\n\n**下周计划**\n- 素材库批量导出\n\n要我再按你的语气润色一遍吗？',
  ],
  [
    /海报|poster/i,
    '好，我按「秋天、咖啡、暖色调」先出 4 张，风格从插画到摄影各一张，生成好会放进素材库。',
  ],
  [
    /每天|定时|schedule/i,
    '可以。我会在每天 9:00 汇总 GitHub 通知，有需要你处理的 PR 会单独列出来；任务页里随时可以暂停或修改。',
  ],
];
const FALLBACK = '收到～我在这儿，随时可以帮你。';

function replyFor(messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === 'user');
  const text =
    typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
  for (const [re, out] of SCRIPTS) if (re.test(text)) return out;
  return FALLBACK;
}

/** @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>} */
export function startMockLlm(port = 0) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const url = (req.url ?? '').replace(/^\/v1/, '');
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.startsWith('/models')) {
        return json(200, {
          object: 'list',
          data: DEMO_MODELS.map((id) => ({ id, object: 'model', owned_by: 'demo' })),
        });
      }
      if (req.method !== 'POST' || !url.startsWith('/chat/completions')) {
        return json(404, { error: { message: 'not found' } });
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // 空体按默认回复
      }
      const text = replyFor(body.messages);
      const base = {
        id: 'chatcmpl-demo',
        created: Math.floor(Date.now() / 1000),
        model: body.model || DEMO_MODELS[0],
      };
      const usage = { prompt_tokens: 1532, completion_tokens: 228, total_tokens: 1760 };
      if (!body.stream) {
        return json(200, {
          ...base,
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage,
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (o) =>
        res.write(
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...o })}\n\n`,
        );
      send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      for (const piece of text.match(/[\s\S]{1,6}/g) ?? []) {
        send({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        await new Promise((r) => setTimeout(r, 10));
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${p}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
