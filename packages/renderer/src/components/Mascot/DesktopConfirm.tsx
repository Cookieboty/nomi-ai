import { layoutStore } from '@nomi-ai/avatar-runtime';
import type { DesktopBubble, DesktopConfirmRequest } from '@nomi-ai/types';
import { t as tr } from '@nomi-ai/ui';
import { Badge, Button, Checkbox, Modal } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './DesktopConfirm.module.css';

import { placeConfirmBubble, type BubblePlacement } from '@/mascot/bubblePlacement';
import { api, hasTransport } from '@/services/api';

/** 桌面能力（看板娘窗口）：确认请求 / 取消 / 气泡经契约事件，答复经 `desktop.confirmAnswer` */
const desktop = {
  onConfirmRequest: (cb: (req: DesktopConfirmRequest) => void) =>
    api.on('desktop.confirmRequest', (r) => cb(r as DesktopConfirmRequest)),
  onConfirmCancel: (cb: (id: string) => void) => api.on('desktop.confirmCancel', cb),
  onBubble: (cb: (p: DesktopBubble) => void) =>
    api.on('desktop.bubble', (p) => cb(p as DesktopBubble)),
  /** 还在等答复的确认请求：看板娘关闭时窗口是为确认框临时建的，建好前发出的请求要补拉 */
  // 请求文件夹只在对话窗口里问（看板娘没有「另选」）
  pending: () =>
    api.desktop
      .state()
      .then((s) => ((s.pending ?? []) as DesktopConfirmRequest[]).filter((r) => r.kind !== 'scope'))
      .catch(() => [] as DesktopConfirmRequest[]),
  answer: (id: string, allow: boolean, remember: boolean) =>
    void api.desktop.confirmAnswer({ id, allow, remember }).catch(() => undefined),
};

const DANGER: Record<
  DesktopConfirmRequest['danger'],
  { label: string; tone: 'neutral' | 'warning' | 'danger' }
> = {
  read: { label: 'ui.chat-settings.read', tone: 'neutral' },
  write: { label: 'ui.chat-settings.write', tone: 'warning' },
  destructive: { label: 'ui.foundation.destructive', tone: 'danger' },
};

const REASON: Record<string, string> = {
  tainted: 'ui.chat-settings.file-contents-were-just-read-this-turn-to',
  destructive: 'ui.chat-settings.destructive-actions-must-be-confirmed-here-moved-to',
  'first-use': 'ui.chat-settings.first-use-of-this-tool-this-session',
  policy: '',
};

/**
 * 桌面工具确认：先在看板娘气泡里问一句；详情对话框显示工具名、参数 JSON 与干跑预览。
 * 破坏性操作只能在对话框里确认，且确认按钮在打开后 1 秒内不可点（防误触）。120 秒未答复由主进程自动拒绝。
 */
export const DesktopConfirm: React.FC = () => {
  const [queue, setQueue] = useState<DesktopConfirmRequest[]>([]);
  const [detail, setDetail] = useState(false);
  const [armed, setArmed] = useState(false);
  const [remember, setRemember] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const bridge = hasTransport() ? desktop : undefined;
  const cur = queue[0];
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<BubblePlacement | null>(null);
  const [fallbackRight, setFallbackRight] = useState<number | null>(null);

  // 与回复气泡共用摆放逻辑：不压脸、不压工具栏、靠近屏幕边缘时翻到另一侧
  const compute = useCallback(() => {
    const el = bubbleRef.current;
    const { head, gutter } = layoutStore.get();
    if (!el) return;
    if (!head) {
      // 头部还没测出来：至少让出工具栏槽位
      setFallbackRight(
        gutter && gutter.left > window.innerWidth / 2 ? window.innerWidth - gutter.left + 8 : null,
      );
      setPlace(null);
      return;
    }
    const p = placeConfirmBubble({
      head,
      gutter,
      view: { width: window.innerWidth, height: window.innerHeight },
      screen: {
        winX: window.screenX,
        availLeft: (window.screen as Screen & { availLeft?: number }).availLeft ?? 0,
        availWidth: window.screen.availWidth,
      },
      measure: (w) => {
        const prev = el.style.cssText;
        el.style.width = `${w}px`;
        el.style.height = 'auto';
        // 量自然高度：不能被上一次摆放的 max-height 截住，否则只会越量越矮
        el.style.maxHeight = 'none';
        const h = el.offsetHeight;
        el.style.cssText = prev;
        return h;
      },
    });
    setPlace((old) =>
      old && old.x === p.x && old.y === p.y && old.width === p.width && old.height === p.height
        ? old
        : p,
    );
  }, []);

  useLayoutEffect(() => {
    // 位置计算需要同步在布局阶段完成，避免首帧闪烁；豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cur) compute();
  }, [cur, compute]);

  useEffect(() => {
    if (!cur) return;
    const off = layoutStore.subscribe(() => compute());
    window.addEventListener('resize', compute);
    const t = setInterval(compute, 1000);
    return () => {
      off();
      window.removeEventListener('resize', compute);
      clearInterval(t);
    };
  }, [cur, compute]);

  useEffect(() => {
    if (!bridge) return;
    const off1 = bridge.onConfirmRequest((r) =>
      setQueue((q) => [...q.filter((x) => x.id !== r.id), r]),
    );
    const off2 = bridge.onConfirmCancel((id) => setQueue((q) => q.filter((x) => x.id !== id)));
    const off3 = bridge.onBubble((p) =>
      window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: p.text, ms: 9000 } })),
    );
    let live = true;
    void bridge.pending().then((list) => {
      if (!live || list.length === 0) return;
      setQueue((q) => [...q, ...list.filter((r) => !q.some((x) => x.id === r.id))]);
    });
    return () => {
      live = false;
      off1();
      off2();
      off3();
    };
  }, [bridge]);

  useEffect(() => {
    if (!cur) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cur]);

  // 切换到新的确认请求时渲染期同步重置记住 / 展开详情，避免 effect 内 setState 的级联渲染
  const [lastCurId, setLastCurId] = useState<string | undefined>(cur?.id);
  if (lastCurId !== cur?.id) {
    setLastCurId(cur?.id);
    setRemember(false);
    setDetail(false);
  }

  useEffect(() => {
    if (!detail) return;
    // 展开详情时先锁定按钮 1s 再放开，防误触：此处 setState 后立即安装定时器，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArmed(false);
    const t = setTimeout(() => setArmed(true), 1000);
    return () => clearTimeout(t);
  }, [detail, cur?.id]);

  if (!cur || !bridge) return null;
  const answer = (allow: boolean) => {
    bridge.answer(cur.id, allow, remember);
    setQueue((q) => q.slice(1));
  };
  const left = Math.max(0, Math.ceil((cur.expiresAt - now) / 1000));
  const d = DANGER[cur.danger];

  return (
    <>
      <div
        ref={bubbleRef}
        className={styles.bubble}
        style={
          place
            ? {
                left: place.x,
                top: place.y,
                width: place.width,
                right: 'auto',
                // 摆放可能把高度压小（头部上下空间不够）：说明文字在气泡内滚动，按钮行始终可见（#80）
                maxHeight: place.height,
              }
            : fallbackRight !== null
              ? { right: fallbackRight }
              : undefined
        }
        data-placement={place?.candidate ?? 'fixed'}
        data-mascot-ui
        data-testid="desktop-confirm-bubble"
        data-danger={cur.danger}
        data-tool={cur.tool}
      >
        <div className={styles.text}>{tr(cur.summary)}</div>
        <div className={styles.meta}>
          <Badge tone={d.tone}>{tr(d.label)}</Badge>
          <span>
            {left}
            {tr('ui.chat-settings.s-until-auto-deny')}
          </span>
        </div>
        <div className={styles.actions}>
          {!cur.dialog && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => answer(true)}
              data-testid="desktop-confirm-allow"
            >
              {tr('ui.chat-settings.allow')}
            </Button>
          )}
          <Button size="sm" onClick={() => setDetail(true)} data-testid="desktop-confirm-details">
            {tr('ui.chat-settings.view-details')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => answer(false)}
            data-testid="desktop-confirm-deny"
          >
            {tr('ui.chat-settings.deny')}
          </Button>
        </div>
      </div>
      {detail && (
        <Modal
          open
          onClose={() => setDetail(false)}
          title={tr('ui.chat-settings.confirm-action')}
          data-testid="desktop-confirm-dialog"
        >
          <div className={styles.dialog}>
            <div className={styles.meta}>
              <Badge tone={d.tone}>{tr(d.label)}</Badge>
              <code>{cur.tool}</code>
            </div>
            <p className={styles.text}>{tr(cur.summary)}</p>
            {REASON[cur.reason] && <p className={styles.hint}>{tr(REASON[cur.reason])}</p>}
            {cur.preview && (
              <>
                <div className={styles.label}>{tr('ui.chat-settings.preview-not-yet-run')}</div>
                <pre className={styles.pre} data-testid="desktop-confirm-preview">
                  {cur.preview}
                </pre>
              </>
            )}
            <div className={styles.label}>{tr('ui.foundation.arguments')}</div>
            <pre className={styles.pre}>{cur.argsJson}</pre>
            {cur.rememberable && (
              <label className={styles.remember}>
                <Checkbox
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  data-testid="desktop-remember"
                />
                {tr('ui.chat-settings.don-t-ask-again-for-this-tool-this')}
              </label>
            )}
            <div className={styles.actions}>
              <Button
                variant="ghost"
                onClick={() => answer(false)}
                data-testid="desktop-dialog-deny"
              >
                {tr('ui.chat-settings.deny')}
              </Button>
              <Button
                variant={cur.danger === 'destructive' ? 'danger' : 'primary'}
                disabled={!armed}
                onClick={() => answer(true)}
                data-testid="desktop-dialog-allow"
              >
                {cur.danger === 'destructive'
                  ? tr('ui.chat-settings.confirm')
                  : tr('ui.chat-settings.allow')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};

export default DesktopConfirm;
