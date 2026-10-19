#!/usr/bin/env node
/**
 * Mock Codex CLI for CI / headed e2e.
 * Supports: --version | exec --json [prompt] | update
 */
const args = process.argv.slice(2);
// 并发测试用：每轮模拟耗时（毫秒）
const delayMs = Number(process.env.NOMI_MOCK_DELAY_MS || 0);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('codex-cli 0.0.0-mock\n');
  process.exit(0);
}
if (args.includes('update')) {
  process.stdout.write('Already up to date\n');
  process.exit(0);
}

/** 官方登录（NOMI_MOCK_LOGIN_EMAIL / NOMI_MOCK_LOGIN_MS / NOMI_MOCK_LOGIN_FAIL）：输出与真实 CLI 一致，凭据写进配置目录 */
function mockJwt(claims) {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}
if (args[0] === 'login' && args.includes('--device-auth')) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  process.stdout.write(
    '\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n' +
      '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n' +
      '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mMOCK-CODE1\x1b[0m\n\n',
  );
  setTimeout(
    () => {
      if (process.env.NOMI_MOCK_LOGIN_FAIL === '1') {
        process.stderr.write('Error: device code expired\n');
        process.exit(1);
      }
      const email = process.env.NOMI_MOCK_LOGIN_EMAIL || 'mock@x.com';
      const dir = process.env.CODEX_HOME;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: mockJwt({ email, sub: `sub-${email}` }),
            access_token: 'at',
            refresh_token: `rt-${email}`,
            account_id: `acct-${email}`,
          },
          last_refresh: new Date().toISOString(),
        }),
      );
      process.stdout.write('Successfully logged in\n');
      process.exit(0);
    },
    Number(process.env.NOMI_MOCK_LOGIN_MS || 200),
  );
} else {
  // exec resume [...flags] <id> <prompt>：续接历史会话
  const resumeAt = args.indexOf('resume');
  const resumed = resumeAt >= 0 ? args.filter((a) => !a.startsWith('-')).slice(2)[0] : '';
  const ownThread = process.env.NOMI_MOCK_SESSION || 'mock-codex-thread-1';
  // 只有续接「别的」会话（历史会话）才改回复，普通多轮对话的回复保持不变
  const foreign = resumed && resumed !== ownThread;
  const reply =
    process.env.NOMI_MOCK_CODEX_REPLY ||
    (foreign ? `【Mock Codex】已续接会话 ${resumed}` : '【Mock Codex】任务完成。');
  const threadId = resumed || ownThread;

  if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  function emit(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  const isExec = args[0] === 'exec' || args[0] === 'e';
  if (!isExec) {
    process.stderr.write('mock-codex: only exec/--version/update supported\n');
    process.exit(2);
  }

  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  emit({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: reply, status: 'completed' },
  });
  emit({
    type: 'turn.completed',
    usage: { input_tokens: 10, output_tokens: 8 },
  });
  process.exit(0);
}
