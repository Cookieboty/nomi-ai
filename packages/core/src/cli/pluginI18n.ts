/**
 * 内置插件（@nomi-ai/cli-plugins）使用统一 i18n 包中的稳定 key。
 * 插件包不依赖 Electron，由宿主在 import 时注入一次（cli-sdk setTranslate，§5.7）。
 */
import { setTranslate } from '@nomi-ai/cli-sdk';

import { t } from '../i18n';

setTranslate((key, ...args) => t(key, ...args));
