// @ts-check
/**
 * nomi/no-cli-literal 的白名单（docs/development/coding-agents.md）：视图里仍按内置编程助手
 * 名字分支的文件。每一项写明原因；能改成能力位的就改，不往这里加新东西。
 * 单独一两行的特例用行内 `// eslint-disable-next-line nomi/no-cli-literal -- 原因`，不进这里。
 */
export const CLI_LITERAL_ALLOWLIST = [
  // 用量与额度：每个 CLI 的额度来源（状态栏 / app-server / ACP 计费）各不相同。
  'packages/ai-chat/src/components/UsagePanel/Quota.tsx',
  // 斜杠命令：每个后端一个适配器的分发表（switch 本身就是按后端的注册表）。
  'packages/ai-chat/src/slash/adapters/index.ts',
];
