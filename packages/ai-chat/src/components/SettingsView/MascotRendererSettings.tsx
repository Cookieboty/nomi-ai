/**
 * 设置 → 通用：桌面角色用 Rive 动画还是静态立绘（Electron 与 Go 宿主相同；docs/design/migrate-2.0.5-go.md Q5，
 * 默认静态）。设置存内核的 `mascot.renderer`，切换时内核广播 `mascot.rendererChanged`，桌面角色窗口实时换。
 * 官方角色的 .riv 是远程素材：打开后内核才下载（character.assetsChanged），这一行显示进度，失败可重试
 * （docs/design/remote-character-assets.md）。
 */
import { Button, SettingRow, Switch, t, tName } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';
import { useCharacterName } from '../../services/characterName';

const ignore = (): undefined => undefined;

type AssetsState = Awaited<ReturnType<typeof api.character.assets>>;

/** 一行设置（放在「桌面<角色名>」分组里）；桌面角色隐藏时整行置灰 */
export const MascotRendererSettings: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const name = useCharacterName();
  const [renderer, setRenderer] = useState<'svg' | 'rive' | null>(null);
  const [assets, setAssets] = useState<AssetsState | null>(null);

  useEffect(() => {
    if (!hasTransport()) return undefined;
    void api.mascot.getRenderer().then(setRenderer, ignore);
    void api.character.assets().then(setAssets, ignore);
    const offRenderer = api.on('mascot.rendererChanged', setRenderer);
    const offAssets = api.on('character.assetsChanged', setAssets);
    return () => {
      offRenderer();
      offAssets();
    };
  }, []);

  if (!hasTransport()) return null;
  // 选了 Rive、但远程素材还没就绪：说明行换成进度 / 失败原因
  const pending = renderer === 'rive' && assets?.remote && assets.status !== 'ready';
  let status: string | null = null;
  if (pending && assets.status === 'downloading') {
    status = t('ui.chat-settings.rive-assets-downloading').replace(
      '{0}',
      String(Math.round(assets.percent ?? 0)),
    );
  } else if (pending && assets.status === 'error') {
    status = t('ui.chat-settings.rive-assets-failed').replace('{0}', assets.error ?? '');
  } else if (pending) {
    status = t('ui.chat-settings.rive-assets-checking');
  }
  return (
    <SettingRow
      data-testid="settings-mascot-renderer"
      title={tName('ui.chat-settings.animated-nomi', name)}
      description={
        status ? (
          <span role="status" data-testid="settings-mascot-renderer-assets">
            {status}
          </span>
        ) : (
          tName('ui.chat-settings.animated-nomi-desc', name)
        )
      }
    >
      {pending && assets.status === 'error' ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="settings-mascot-renderer-retry"
          onClick={() => void api.character.ensureAssets().then(setAssets, ignore)}
        >
          {t('ui.mascot-theme.retry')}
        </Button>
      ) : null}
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
