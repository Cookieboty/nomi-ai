/**
 * 斜杠命令 `/model` 打开输入框上方的模型浮层（与点模型按钮是同一个界面），不往对话里插卡片。
 * 输入框的模型按钮挂载时按 key 登记打开方法：编程助手标签用标签 id，Nomi 对话用 NOMI_MODEL_MENU。
 */
export const NOMI_MODEL_MENU = 'nomi';

const openers = new Map<string, (query: string) => void>();

/** 登记打开方法；返回注销函数（只注销自己登记的那一个） */
export function registerModelMenu(key: string, open: (query: string) => void): () => void {
  openers.set(key, open);
  return () => {
    if (openers.get(key) === open) openers.delete(key);
  };
}

/**
 * 打开对应的模型浮层；query 预填进搜索框（有搜索框时）。
 * 没有登记（按钮还在读模型目录、这个 CLI 不能按标签切模型）返回 false，由调用方退回卡片。
 */
export function openModelMenu(key: string, query = ''): boolean {
  const open = openers.get(key);
  if (!open) return false;
  // 等斜杠命令这次按键 / 点击处理完再打开，免得刚打开就被同一个事件当成「点了外面」关掉
  setTimeout(() => open(query), 0);
  return true;
}
