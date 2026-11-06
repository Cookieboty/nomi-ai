/**
 * 「+」菜单的第二层：下一条消息交给哪个编程助手。只列已安装的；与 `/agent <cli>` 用同一个钉住，
 * 选了之后输入框上方出现「交给 X ×」。委派没开时只给一句去哪儿打开的说明。
 */
import { Icon, t as tr } from '@nomi-ai/ui';
import { ChevronLeft } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { delegateClient, type DelegateCli } from '../../services/delegateClient';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import styles from './index.module.css';

export const DelegateMenu: React.FC<{
  onBack: () => void;
  onPick: (cli: DelegateCli) => void;
}> = ({ onBack, onPick }) => {
  const [st, setSt] = useState<{ enabled: boolean; installed: DelegateCli[] } | null>(null);
  useEffect(() => {
    let live = true;
    void delegateClient
      .settings()
      .then(
        (v) =>
          live &&
          setSt({
            enabled: !!v?.enabled,
            installed: Array.isArray(v?.installed) ? (v.installed as DelegateCli[]) : [],
          }),
      )
      .catch(() => live && setSt({ enabled: false, installed: [] }));
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <button
        type="button"
        role="menuitem"
        className={styles.menuItem}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onBack}
        data-testid="composer-delegate-back"
      >
        <span className={styles.menuIcon}>
          <Icon icon={ChevronLeft} size={16} />
        </span>
        <span className={styles.menuLabel}>
          {tr('ui.slash-commands.hand-off-to-a-coding-assistant')}
        </span>
      </button>
      {st && !st.enabled && (
        <p className={styles.menuNote} data-testid="composer-delegate-off">
          {tr('ui.slash-commands.let-nomi-hand-off-tasks-to-coding-assistants')}
        </p>
      )}
      {st?.enabled && st.installed.length === 0 && (
        <p className={styles.menuNote}>{tr('ui.slash-commands.no-coding-assistants-installed')}</p>
      )}
      {st?.enabled &&
        st.installed.map((cli) => (
          <button
            key={cli}
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(cli)}
            data-testid={`composer-delegate-${cli}`}
          >
            <span className={styles.menuIcon}>
              <EndpointIcon backend={cli} size={16} decorative />
            </span>
            <span className={styles.menuLabel}>{ENDPOINT_FULL[cli]()}</span>
          </button>
        ))}
    </>
  );
};
