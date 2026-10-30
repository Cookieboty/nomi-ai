#!/usr/bin/env node
/**
 * 测试用 CLI：先输出一段文字，随后按 NOMI_MOCK_PARTIAL_MODE 行为：
 *   hang  → 保持运行（等待被停止）
 *   exit1 → 退出码 1（不发完成事件）
 *   ok    → 发完成事件并以 0 退出
 *   done-exit1 → 发完成事件但以 1 退出（收尾阶段异常退出）
 * 输出格式由 NOMI_MOCK_PARTIAL_KIND 决定：codex | dsh | grok
 */
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('9.9.9-partial\n');
  process.exit(0);
}
const kind = process.env.NOMI_MOCK_PARTIAL_KIND || 'codex';
const mode = process.env.NOMI_MOCK_PARTIAL_MODE || 'ok';
const textOnly = process.env.NOMI_MOCK_PARTIAL_NO_TEXT !== '1';
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const TEXT = '部分输出';

if (kind === 'codex') {
  emit({ type: 'thread.started', thread_id: 'partial-thread' });
  if (textOnly)
    emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: TEXT } });
} else if (kind === 'dsh') {
  emit({ type: 'session', sessionId: 'partial-session' });
  if (textOnly) emit({ type: 'text', text: TEXT });
} else {
  if (textOnly) emit({ type: 'text', data: TEXT });
}

const complete = () => {
  if (kind === 'codex')
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  else if (kind === 'dsh') emit({ type: 'final', text: TEXT });
  else emit({ type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } });
};

if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'exit1') {
  setTimeout(() => process.exit(1), 50);
} else if (mode === 'done-exit1') {
  complete();
  setTimeout(() => process.exit(1), 50);
} else {
  complete();
  setTimeout(() => process.exit(0), 20);
}
