import { createTsup } from '../../tsup.base';

// 每个子路径一个入口，产物目录与子路径一致
export default createTsup({
  preset: 'node-lib',
  entry: {
    index: 'src/index.ts',
    manifest: 'src/manifest.ts',
    'claude/manifest': 'src/claude/manifest.ts',
    'codex/manifest': 'src/codex/manifest.ts',
    'dsh/manifest': 'src/dsh/manifest.ts',
    'gemini/manifest': 'src/gemini/manifest.ts',
    'grok/manifest': 'src/grok/manifest.ts',
  },
});
