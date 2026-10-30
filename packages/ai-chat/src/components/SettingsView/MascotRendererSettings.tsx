/**
 * 设置 → 通用：看板娘用 Rive 动画还是静态立绘（Electron 与 Go 宿主相同；docs/design/migrate-2.0.5-go.md Q5，
 * 默认静态）。设置存内核的 `mascot.renderer`，切换时内核广播 `mascot.rendererChanged`，看板娘窗口实时换。
 */
import { SettingRow, Switch, tName } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';
import { useCharacterName } from '../../services/characterName';

const ignore = (): undefined => undefined;

/** 一行设置（放在「桌面<角色名>」分组里）；看板娘隐藏时整行置灰 */
export const MascotRendererSettings: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const name = useCharacterName();
  const [renderer, setRenderer] = useState<'svg' | 'rive' | null>(null);

  useEffect(() => {
    if (!hasTransport()) return undefined;
    void api.mascot.getRenderer().then(setRenderer, ignore);
    return api.on('mascot.rendererChanged', setRenderer);
  }, []);

  if (!hasTransport()) return null;
  return (
    <SettingRow
      data-testid="settings-mascot-renderer"
      title={tName('ui.chat-settings.animated-nomi', name)}
      description={tName('ui.chat-settings.animated-nomi-desc', name)}
    >
      <Switch
        checked={renderer === 'rive'}
        disabled={disabled || renderer === null}
        onChange={(on) =>
          void api.mascot.setRenderer({ renderer: on ? 'rive' : 'svg' }).then(setRenderer, ignore)
        }
        aria-label={tName('ui.chat-settings.animated-nomi', name)}
      />
    </SettingRow>
  );
};
