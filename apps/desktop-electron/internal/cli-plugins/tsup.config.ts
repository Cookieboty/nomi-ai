import { createTsup } from '../../../../tsup.base';

// 每个子路径一个入口（<cli>/{main,gateway}），产物目录与子路径一致；清单与界面信息在 @nomi-ai/cli-catalog
export default createTsup({
  preset: 'node-lib',
  entry: {
    index: 'src/index.ts',
    main: 'src/main.ts',
    gateways: 'src/gateways.ts',
    'claude/main': 'src/claude/main.ts',
    'claude/gateway': 'src/claude/gateway.ts',
    'codex/main': 'src/codex/main.ts',
    'codex/gateway': 'src/codex/gateway.ts',
    'dsh/main': 'src/dsh/main.ts',
    'dsh/gateway': 'src/dsh/gateway.ts',
    'gemini/main': 'src/gemini/main.ts',
    'gemini/gateway': 'src/gemini/gateway.ts',
    'grok/main': 'src/grok/main.ts',
    'grok/gateway': 'src/grok/gateway.ts',
  },
  external: ['@nomi-ai/cli-sdk', '@nomi-ai/cli-catalog'],
});
