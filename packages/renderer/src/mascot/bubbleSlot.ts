/**
 * 头部旁边的气泡位一次只放一个：桌面工具的确认气泡（DesktopConfirm）与普通台词气泡（MessageBubble）
 * 用同一套摆放规则，同时出现会叠在同一处（2.1.1 测试报告：引导阶段连续几条时气泡叠在一起）。
 * 确认气泡在场时它优先，台词气泡先让开；确认结束后台词照常显示。
 */
type Listener = () => void;

let confirmUp = false;
const subs = new Set<Listener>();

export const bubbleSlot = {
  /** 确认气泡是否占着气泡位 */
  confirmShown: (): boolean => confirmUp,
  setConfirmShown(on: boolean): void {
    if (on === confirmUp) return;
    confirmUp = on;
    subs.forEach((fn) => fn());
  },
  subscribe(fn: Listener): () => void {
    subs.add(fn);
    return () => void subs.delete(fn);
  },
};
