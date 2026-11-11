/**
 * 对话窗口底部（授权卡片上方）的「正在操作桌面 · 停止」：Nomi 或编程助手经 computer_* 操作本机应用时出现，
 * 点「停止」= 紧急停止（中止正在操作桌面的那几轮，撤掉确认卡）。被操作的应用在前台时用系统级快捷键停止。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { MousePointerClick } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';

import styles from './index.module.css';

export const ComputerActivityBar: React.FC = () => {
  const [active, setActive] = useState<string[]>([]);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!hasTransport()) return undefined;
    let alive = true;
    const off = api.on('computer.activity', (e) => setActive(e.active));
    // 打开时已经有操作在进行：先读一次当前状态，不等下一个事件
    void api.computer
      .active()
      .then((r) => {
        if (alive) setActive(r.active);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (active.length === 0) return null;

  const stop = async () => {
    setStopping(true);
    try {
      await api.computer.stop();
      setActive([]);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className={styles.bar} role="status" data-testid="computer-activity-bar">
      <Icon icon={MousePointerClick} size={16} />
      <span className={styles.text}>
        {t('ui.chat-settings.computer-active-now').replace('{0}', active.join(' · '))}
      </span>
      <Button
        size="sm"
        variant="danger"
        disabled={stopping}
        onClick={() => void stop()}
        data-testid="computer-activity-stop"
      >
        {t('ui.foundation.stop')}
      </Button>
    </div>
  );
};
