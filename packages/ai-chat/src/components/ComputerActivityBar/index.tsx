/**
 * 对话窗口底部（授权卡片上方）的「正在操作桌面 · 停止」：Nomi 或编程助手经 computer_* 操作本机应用时出现，
 * 点「停止」= 紧急停止（取消正在执行 / 等确认的桌面操作）。灵动岛上有同一个按钮（被操作的应用在前台时也点得到）。
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
    return api.on('computer.activity', (e) => setActive(e.active));
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
