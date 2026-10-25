/**
 * 设置 →「模型」→ 终端启动命令（docs/design/unified-gateway.md §12.6，默认关）。
 * 打开后生成 ~/.nomi/bin/nomi-claude 等脚本；加 PATH 要改 shell 配置文件，先弹窗确认。
 * Windows 经确认后加入用户 PATH，关闭时只移除 Nomi 添加的项。
 */
import { Button, Icon, Modal, Switch, t } from '@nomi-ai/ui';
import { SquareTerminal } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  terminalCommandsClient,
  type TerminalCommandsState,
} from '../../services/terminalCommandsClient';

import styles from './TerminalCommandsCard.module.css';

export const TerminalCommandsCard: React.FC = () => {
  const [st, setSt] = useState<TerminalCommandsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    terminalCommandsClient
      .state()
      .then((s) => alive && setSt(s))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const apply = useCallback(async (input: { enabled: boolean; addToPath?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      setSt(await terminalCommandsClient.set(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const enabled = st?.enabled ?? false;

  return (
    <section className={styles.card} data-testid="terminal-commands-card">
      <div className={styles.head}>
        <h3 className={styles.title}>
          <Icon icon={SquareTerminal} size={16} />
          {t('ui.models.terminal-commands')}
        </h3>
        <Switch
          checked={enabled}
          disabled={!st || busy}
          onChange={(on) => void apply({ enabled: on })}
          aria-label={t('ui.models.terminal-commands')}
        />
      </div>
      <p className={styles.desc}>{t('ui.models.use-third-party-models-in-a-terminal-with')}</p>
      {st && enabled && (
        <>
          <div className={styles.row}>
            <span>{t('ui.models.command-folder')}</span>
            <code className={styles.code} data-testid="terminal-bin-dir">
              {st.binDir}
            </code>
          </div>
          <div className={styles.row}>
            <span>{t('ui.slash-commands.available-commands')}</span>
            {st.commands.map((c) => (
              <code key={c} className={styles.code}>
                {c}
              </code>
            ))}
          </div>
          {st.pathSupported ? (
            <div className={styles.row} data-testid="terminal-path-status">
              {st.pathAdded ? (
                <>
                  <span className={styles.ok}>
                    {st.pathKind === 'user-path'
                      ? t('ui.models.added-to-your-user-path-restart-your-terminal')
                      : t(
                          'ui.models.added-to-path-takes-effect-in-new-terminals',
                          st.rcFiles.join('、'),
                        )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void apply({ enabled: true, addToPath: false })}
                  >
                    {t('ui.models.remove-from-path')}
                  </Button>
                </>
              ) : (
                <>
                  <span>{t('ui.models.not-on-path-yet-run-the-commands-by')}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setConfirming(true)}
                  >
                    {t('ui.models.add-to-path')}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <p className={styles.desc} data-testid="terminal-path-status">
              {t('ui.models.on-windows-nomi-doesn-t-change-path-add')}
            </p>
          )}
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('ui.models.add-nomi-bin-to-path')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('ui.foundation.cancel')}
            </Button>
            <Button
              variant="primary"
              data-testid="terminal-path-confirm"
              onClick={() => {
                setConfirming(false);
                void apply({ enabled: true, addToPath: true });
              }}
            >
              {t('ui.models.add-to-path-4cc95c')}
            </Button>
          </>
        }
      >
        <p className={styles.desc}>
          {st?.pathKind === 'user-path'
            ? t('ui.models.nomi-will-add-the-command-folder-to-your')
            : t('ui.models.nomi-will-append-a-marked-block-to-the')}
        </p>
        <ul className={styles.list}>
          {st?.rcFiles.map((f) => (
            <li key={f}>
              <code className={styles.code}>{f}</code>
            </li>
          ))}
        </ul>
      </Modal>
    </section>
  );
};

export default TerminalCommandsCard;
