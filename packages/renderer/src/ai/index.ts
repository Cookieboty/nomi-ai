export { default as CompanionAIRoot } from './CompanionAIRoot';
export { default as CompanionLipSyncBridge } from './CompanionLipSyncBridge';
export { default as CompanionAgentBubbleBridge } from './CompanionAgentBubbleBridge';
export { lipSyncStore } from './lipSyncStore';
export type { LipSyncListener } from './lipSyncStore';
export {
  AGENT_STEP_LABEL,
  BUBBLE_PRIORITY,
  BUBBLE_TIMEOUT,
  deriveBubble,
  extractAssistantText,
  shouldSuppress,
  truncateForBubble,
} from './bubbleReducer';
export type {
  BubbleAgentStep,
  BubbleDirective,
  BubbleEvent,
  BubbleMessage,
  BubbleMessageComplete,
  BubbleMessagePart,
  BubbleToolExecuted,
  DedupeState,
} from './bubbleReducer';
