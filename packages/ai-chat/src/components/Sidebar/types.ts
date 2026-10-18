import type { ChatSession } from '../../types/chat';

/** 侧栏列表里用的会话元数据（不含消息体） */
export type Meta = Omit<ChatSession, 'messages'>;
