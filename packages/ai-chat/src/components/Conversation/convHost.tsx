/** 这份会话挂在哪个编程助手标签上（Nomi 主对话为 null）。子代理「查看」用它找父转录。 */
import { createContext } from 'react';

export const ConvHostContext = createContext<string | null>(null);
