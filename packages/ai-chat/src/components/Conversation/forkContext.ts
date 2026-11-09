/**
 * 消息末尾的「分叉」：从这条回复往前分叉（之后的消息不带），由 App 提供打开分叉弹窗的回调。
 * 没有提供（独立渲染的会话视图、测试）时不显示按钮。
 */
import { createContext } from 'react';

export const ForkFromMessageContext = createContext<((messageId: string) => void) | null>(null);
