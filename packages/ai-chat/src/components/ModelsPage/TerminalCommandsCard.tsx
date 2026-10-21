/**
 * 设置 →「模型」→ 终端启动命令（docs/design/unified-gateway.md §12.6，默认关）。
 * 打开后生成 ~/.nomi/bin/nomi-claude 等脚本；加 PATH 要改 shell 配置文件，先弹窗确认。
 * Windows 不改 PATH，只显示目录让用户自己添加。
 */
import { Button, Modal, Switch, t } from '@nomi-ai/ui';
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
        <h3 className={styles.title}>{t('终端启动命令')}</h3>
        <Switch
          checked={enabled}
          disabled={!st || busy}
          onChange={(on) => void apply({ enabled: on })}
          aria-label={t('终端启动命令')}
        />
      </div>
      <p className={styles.desc}>
        {t(
          '在终端里用 nomi-claude、nomi-codex 等命令使用第三方模型；直接运行 claude、codex 仍是官方登录。',
        )}
      </p>
      {st && enabled && (
        <>
          <div className={styles.row}>
            <span>{t('命令所在目录')}</span>
            <code className={styles.code} data-testid="terminal-bin-dir">
              {st.binDir}
            </code>
          </div>
          <div className={styles.row}>
            <span>{t('可用命令')}</span>
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
                    {t('已加入 PATH（新打开的终端生效）：{0}', st.rcFiles.join('、'))}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void apply({ enabled: true, addToPath: false })}
                  >
                    {t('从 PATH 移除')}
                  </Button>
                </>
              ) : (
                <>
                  <span>{t('还没有加入 PATH，可以用完整路径运行，或者加入 PATH。')}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setConfirming(true)}
                  >
                    {t('加入 PATH…')}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <p className={styles.desc} data-testid="terminal-path-status">
              {t('Windows 上 Nomi 不修改 PATH：请把上面的目录手动添加到用户环境变量 PATH。')}
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
        title={t('把 ~/.nomi/bin 加入 PATH？')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              data-testid="terminal-path-confirm"
              onClick={() => {
                setConfirming(false);
                void apply({ enabled: true, addToPath: true });
              }}
            >
              {t('加入 PATH')}
            </Button>
          </>
        }
      >
        <p className={styles.desc}>
          {t(
            'Nomi 会在下面的文件末尾加一段带标记的内容，把命令所在目录加进 PATH；关闭开关时删除这一段，不改其他内容。',
          )}
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
