import { createTsup } from '../../tsup.base';

// 每个子路径一个入口（<cli>/{manifest,main,gateway,renderer}），产物目录与子路径一致
export default createTsup({
  preset: 'node-lib',
  entry: {
    index: 'src/index.ts',
    catalog: 'src/catalog.ts',
    main: 'src/main.ts',
    gateways: 'src/gateways.ts',
    'claude/manifest': 'src/claude/manifest.ts',
    'claude/main': 'src/claude/main.ts',
    'claude/gateway': 'src/claude/gateway.ts',
    'claude/renderer': 'src/claude/renderer.ts',
    'codex/manifest': 'src/codex/manifest.ts',
    'codex/main': 'src/codex/main.ts',
    'codex/gateway': 'src/codex/gateway.ts',
    'codex/renderer': 'src/codex/renderer.ts',
    'dsh/manifest': 'src/dsh/manifest.ts',
    'dsh/main': 'src/dsh/main.ts',
    'dsh/gateway': 'src/dsh/gateway.ts',
    'dsh/renderer': 'src/dsh/renderer.ts',
    'gemini/manifest': 'src/gemini/manifest.ts',
    'gemini/main': 'src/gemini/main.ts',
    'gemini/gateway': 'src/gemini/gateway.ts',
    'gemini/renderer': 'src/gemini/renderer.ts',
    'grok/manifest': 'src/grok/manifest.ts',
    'grok/main': 'src/grok/main.ts',
    'grok/gateway': 'src/grok/gateway.ts',
    'grok/renderer': 'src/grok/renderer.ts',
  },
  external: ['@nomi-ai/cli-sdk'],
});
