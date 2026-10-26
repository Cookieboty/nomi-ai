/**
 * userData/tts-config.json：实时朗读引擎 + 诺米提示语音开关。
 */
import * as fs from 'fs';
import * as path from 'path';

import type { TTSConfig } from '@nomi-ai/types';
import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';
import { app } from 'electron';

import { writePrivateFile } from '../utils/privateFile';

import { normalizeTtsConfig, validateTtsConfig } from './ttsConfig';

export class TtsConfigStore {
  private configPath(): string {
    return path.join(app.getPath('userData'), 'tts-config.json');
  }

  load(): TTSConfig {
    try {
      const p = this.configPath();
      if (!fs.existsSync(p)) return { ...DEFAULT_TTS_CONFIG, lastModified: 0 };
      return normalizeTtsConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch {
      return { ...DEFAULT_TTS_CONFIG, lastModified: 0 };
    }
  }

  save(input: TTSConfig): TTSConfig {
    const v = validateTtsConfig(input);
    if (!v.isValid) throw new Error(`TTS config invalid: ${v.errors.join(', ')}`);
    const config = { ...normalizeTtsConfig(input), lastModified: Date.now() };
    writePrivateFile(this.configPath(), JSON.stringify(config, null, 2));
    return config;
  }

  reset(): void {
    const p = this.configPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

let store: TtsConfigStore | null = null;
export function getTtsConfigStore(): TtsConfigStore {
  return (store ??= new TtsConfigStore());
}
