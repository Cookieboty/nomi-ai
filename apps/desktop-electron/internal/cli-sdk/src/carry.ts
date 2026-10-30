/**
 * Nomi 换工作目录 / 分叉时带入新会话的前文格式（主进程 cli/contextCarry.ts 生成）：
 * 读历史 / 起标题时要把它去掉，只留用户原话。宿主与插件共用这一个约定。
 */
export const CARRY_END = '</previous_conversation>\n\n---\n\n';

/** 从 CLI 落盘的用户消息里去掉 Nomi 带入的前文，只留用户原话（读历史时用） */
export function stripCarriedContext(text: string): string {
  const i = text.indexOf(CARRY_END);
  return i >= 0 && text.trimStart().startsWith('[Nomi]') ? text.slice(i + CARRY_END.length) : text;
}
