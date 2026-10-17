/**
 * 统一会话模型：Nomi 普通对话与 Claude Code / Codex / Grok / dsh 标签共用同一套会话视图，
 * 视图只认这里的形状；各来源（ChatMessage / HarnessTabMessage）经 utils/convAdapters 转换。
 */
import type { HarnessTraceEvent, HarnessUsage } from '../services/harnessClient';

export interface ConvMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 消息时间（ms）；助手消息为这一轮结束的时间 */
  at: number;
  /** 工具调用 / 思考轨迹（与来源无关的同一种事件） */
  trace?: HarnessTraceEvent[];
  /** 旧版只存了工具名的消息 */
  legacyTools?: string[];
  /** 本轮失败：错误文本（text 为失败前已生成的部分） */
  error?: string;
  /** 被用户中断 */
  stopped?: boolean;
  /** 本轮耗时（ms） */
  durationMs?: number;
  usage?: HarnessUsage;
  /** 展示在元信息里的来源标签（模型 / 后端名） */
  label?: string;
  /** 原始消息（来源特有的扩展内容由 slots 渲染） */
  raw?: unknown;
}

/** 运行中的一轮（尚未落盘成消息） */
export interface ConvLive {
  text: string;
  trace?: HarnessTraceEvent[];
  startedAt?: number;
  /** 收到第一个输出事件的时间；undefined 表示仍在等待模型首字 */
  firstEventAt?: number;
  permission?: { id: string; summary: string };
  status?: {
    kind: 'retry' | 'reconnect' | 'compact';
    text?: string;
    attempt?: number;
    max?: number;
  };
}

export type ConvPhase = 'idle' | 'queued' | 'running';
