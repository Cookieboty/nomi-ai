import { t as tr } from '@nomi-ai/ui';
import React from 'react';

import { delegateClient } from '../../services/delegateClient';
import { extClient } from '../../services/extClient';
import { memClient } from '../../services/memClient';
import { schedClient } from '../../services/schedClient';
import { formatCombo, type ShortcutId } from '../../services/shortcuts';
import { buildRegistry } from '../../slash/registry';
import type { SlashCommand } from '../../slash/types';
import { AppIcon, FEATURE_ICONS } from '../AppIcons';
import type { SettingsSectionInput } from '../SettingsView/sections';

export interface SlashCommandItem {
  id: string;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  testId: string;
  run: () => void;
  show: boolean;
  active?: boolean;
  menu?: boolean;
  submenu?: 'delegate';
}

interface CommandCallbacks {
  onAttach: () => void;
  onProvidersClick?: () => void;
  onDesktopClick?: () => void;
  onHubClick?: () => void;
  onExtClick?: () => void;
  onLocalClick?: () => void;
  onSettingsClick?: (section?: SettingsSectionInput) => void;
  onPluginsClick?: () => void;
  toggleKb: () => void;
  insertAt: () => void;
}

interface CommandOptions {
  bindings: Record<ShortcutId, string>;
  kbMode: boolean;
  kbAvailable: boolean;
  cwd: string | null | undefined;
  delegate: boolean | undefined;
  cvReady: boolean;
  cvAvailable: boolean;
  onCvSettings: () => void;
}

export function buildAllCommands(
  callbacks: CommandCallbacks,
  options: CommandOptions,
): SlashCommandItem[] {
  const {
    onAttach,
    onProvidersClick,
    onDesktopClick,
    onHubClick,
    onExtClick,
    onLocalClick,
    onSettingsClick,
    onPluginsClick,
    toggleKb,
    insertAt,
  } = callbacks;
  const { bindings, kbMode, kbAvailable, cwd, delegate, cvReady, cvAvailable, onCvSettings } =
    options;

  return [
    {
      id: 'attach',
      icon: <AppIcon icon={FEATURE_ICONS.attach} />,
      label: tr('ui.knowledge-local.add-images-or-files'),
      testId: 'composer-attach',
      menu: true,
      run: onAttach,
      show: true,
    },
    {
      id: 'mention',
      icon: <AppIcon icon={FEATURE_ICONS.mention} />,
      label: tr('ui.knowledge-local.reference-a-file-or-folder'),
      hint: '@',
      testId: 'composer-mention',
      menu: true,
      run: insertAt,
      show: !!cwd,
    },
    {
      id: 'delegate',
      icon: <AppIcon icon={FEATURE_ICONS.delegate} />,
      label: tr('ui.slash-commands.hand-off-to-a-coding-assistant'),
      hint: '›',
      testId: 'composer-delegate',
      menu: true,
      run: () => undefined,
      submenu: 'delegate',
      show: !!delegate && delegateClient.available(),
    },
    {
      id: 'kb',
      icon: <AppIcon icon={FEATURE_ICONS.kb} />,
      label: kbMode
        ? tr('ui.knowledge-local.knowledge-base-q-a-on')
        : tr('ui.knowledge-local.knowledge-base-q-a-off'),
      hint: formatCombo(bindings.kbAsk),
      testId: 'kb-mode-toggle',
      menu: true,
      run: toggleKb,
      show: kbAvailable,
      active: kbMode,
    },
    {
      id: 'model',
      icon: <AppIcon icon={FEATURE_ICONS.model} />,
      label: tr('ui.knowledge-local.providers-models'),
      testId: 'open-providers',
      run: () => onProvidersClick?.(),
      show: true,
    },
    {
      id: 'voice',
      icon: <AppIcon icon={FEATURE_ICONS.voice} />,
      label: cvReady
        ? tr('ui.knowledge-local.voice-settings')
        : tr('ui.knowledge-local.set-up-voice-input'),
      hint: cvReady ? tr('ui.knowledge-local.f2-to-talk') : undefined,
      testId: 'open-voice-settings',
      menu: !cvReady,
      run: onCvSettings,
      show: cvAvailable,
    },
    {
      id: 'hub',
      icon: <AppIcon icon={FEATURE_ICONS.hub} />,
      label: tr('ui.chat-settings.knowledge-memory-schedule'),
      hint: formatCombo(bindings.hub),
      testId: 'open-hub-panel',
      run: () => onHubClick?.(),
      show: !!onHubClick && (kbAvailable || memClient.available() || schedClient.available()),
    },
    {
      id: 'ext',
      icon: <AppIcon icon={FEATURE_ICONS.ext} />,
      label: tr('ui.foundation.extensions-mcp-skills'),
      hint: formatCombo(bindings.ext),
      testId: 'open-ext-panel',
      run: () => onExtClick?.(),
      show: !!onExtClick && extClient.available(),
    },
    {
      id: 'plugins',
      icon: <AppIcon icon={FEATURE_ICONS.cliPlugins} />,
      label: tr('ui.slash-commands.plugins-commands'),
      testId: 'plugin-panel-open',
      menu: true,
      run: () => onPluginsClick?.(),
      show: !!onPluginsClick,
    },
    {
      id: 'desktop',
      icon: <AppIcon icon={FEATURE_ICONS.desktop} />,
      label: tr('ui.foundation.desktop-abilities'),
      testId: 'open-desktop-panel',
      run: () => onDesktopClick?.(),
      show: !!onDesktopClick,
    },
    {
      id: 'local',
      icon: <AppIcon icon={FEATURE_ICONS.local} />,
      label: tr('ui.knowledge-local.local-models'),
      hint: formatCombo(bindings.local),
      testId: 'open-local-panel',
      run: () => onLocalClick?.(),
      show: !!onLocalClick && extClient.available(),
    },
    {
      id: 'settings',
      icon: <AppIcon icon={FEATURE_ICONS.settings} />,
      label: tr('ui.knowledge-local.all-settings'),
      hint: formatCombo(bindings.settings),
      testId: 'composer-settings',
      run: () => onSettingsClick?.(),
      show: !!onSettingsClick,
    },
  ];
}

export function commandsToSlashCommands(commands: SlashCommandItem[]): SlashCommand[] {
  return commands
    .filter((c) => !c.submenu)
    .map((c) => ({
      id: `ui:${c.id}`,
      name: c.id === 'model' ? 'providers' : c.id,
      label: tr(c.label),
      description: tr(c.label),
      source: 'ui' as const,
      kind: 'ui' as const,
      run: () => {
        c.run();
        return { type: 'noop' as const };
      },
    }));
}

export function buildCommandRegistry(
  uiCommands: SlashCommand[],
  slash?: { compose: (ui: SlashCommand[]) => SlashCommand[] },
): SlashCommand[] {
  return slash ? slash.compose(uiCommands) : buildRegistry(uiCommands);
}
