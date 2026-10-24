/**
 * 响应方向的模型规则（§6.9.7）：结构修复只作用在 NormEvent 上——正文里的工具调用、工具名还原、
 * 复读检测、finish_reason 校正、确定性的工具调用 id。规范化层（canonical/）只管协议有效性。
 */
export * from './fixer';
