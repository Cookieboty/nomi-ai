/**
 * 内置插件（@nomi-ai/cli-plugins）里面向用户的文案走主进程的 t()：插件包不依赖 Electron，
 * 由宿主在 import 时注入一次（cli-sdk setTranslate，§5.7）。英文在 i18n/en.json。
 */
import { setTranslate } from '@nomi-ai/cli-sdk';

import { t } from '../i18n';

setTranslate((key, ...args) => t(key, ...args));
