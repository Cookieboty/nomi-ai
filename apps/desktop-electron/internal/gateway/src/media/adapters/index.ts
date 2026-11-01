/** 适配器注册表：id → 适配器。新增一家把它加进来，再在 endpoints.ts 的规则表里用它的 id */
import type { ImageAdapter } from '../types';

import { arkImage } from './arkImage';
import { dashscope } from './dashscope';
import { fal } from './fal';
import { gemini } from './gemini';
import { imagen } from './imagen';
import { openaiImages } from './openaiImages';
import { openrouterChatImage } from './openrouterChatImage';

export const IMAGE_ADAPTERS: Readonly<Record<string, ImageAdapter>> = Object.fromEntries(
  [openaiImages, arkImage, gemini, imagen, openrouterChatImage, fal, dashscope].map((a) => [
    a.id,
    a,
  ]),
);
