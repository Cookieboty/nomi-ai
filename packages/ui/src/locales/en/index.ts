import chat_settings from './chat-settings.json';
import cli_monitor from './cli-monitor.json';
import foundation from './foundation.json';
import knowledge_local from './knowledge-local.json';
import mascot_theme from './mascot-theme.json';
import models from './models.json';
import providers_schedule from './providers-schedule.json';
import slash_commands from './slash-commands.json';
import usage_tools from './usage-tools.json';
import voice_mascot from './voice-mascot.json';

const en = {
  ...foundation,
  ...knowledge_local,
  ...providers_schedule,
  ...chat_settings,
  ...voice_mascot,
  ...mascot_theme,
  ...cli_monitor,
  ...usage_tools,
  ...slash_commands,
  ...models,
};

export default en;
