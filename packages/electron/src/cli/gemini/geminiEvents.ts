/**
 * ACP `session/update` → HarnessEvent：实现已搬到 @nomi-ai/cli-sdk 的 ACP 驱动
 * （`createAcpMapper`，docs/design/cli-plugin-architecture.md §5.4），这里保留旧名字。
 */
export { createGeminiMapper, permissionSummary, pickPermissionOption } from '@nomi-ai/cli-sdk';
