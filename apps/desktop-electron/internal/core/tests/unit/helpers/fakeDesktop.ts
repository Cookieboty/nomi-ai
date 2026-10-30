import type { DesktopNotice, NoticeChannel } from '../../../src/desktop/DesktopService';

/**
 * 测试用的 DesktopService 替身：notify 与真实实现同一套路由——看板娘在 → 只走 say（气泡）；
 * 不在（hidden() 为 true）→ 只走 island（灵动岛）。
 */
export function fakeDesktop(
  say: (text: string, opts?: unknown) => void,
  opts: { island?: (n: unknown) => void; hidden?: () => boolean } = {},
) {
  return {
    say,
    notify: (n: DesktopNotice): NoticeChannel => {
      if (!opts.hidden?.()) {
        if (n.bubble) say(n.text, n.bubble);
        else say(n.text);
        return 'bubble';
      }
      opts.island?.({
        kind: n.kind,
        title: n.title,
        body: n.body ?? n.text,
        status: n.status,
        endpoint: n.endpoint,
      });
      return 'island';
    },
  };
}
