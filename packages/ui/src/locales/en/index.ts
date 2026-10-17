import foundation from './foundation.json';
import knowledge_local from './knowledge-local.json';
import providers_schedule from './providers-schedule.json';
import chat_settings from './chat-settings.json';
import voice_mascot from './voice-mascot.json';
import mascot_theme from './mascot-theme.json';
import cli_monitor from './cli-monitor.json';
import usage_tools from './usage-tools.json';

const en = {
  ...foundation,
  ...knowledge_local,
  ...providers_schedule,
  ...chat_settings,
  ...voice_mascot,
  ...mascot_theme,
  ...cli_monitor,
  ...usage_tools,
};

export default en;
