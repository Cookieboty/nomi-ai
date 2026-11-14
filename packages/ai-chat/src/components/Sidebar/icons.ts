import {
  IconClockHour8,
  IconDots as Ellipsis,
  IconPhotoSquareRounded,
  IconSubtask,
  IconSmartHome,
  IconEdit as PenLine,
  IconSettings,
} from '@tabler/icons-react';

/** 工作台侧栏：简洁轮廓、导航尺寸，独立于内容区的功能图标选型。 */
export const SIDEBAR_ICONS = {
  chats: IconSmartHome,
  tasks: IconClockHour8,
  agents: IconSubtask,
  assets: IconPhotoSquareRounded,
  settings: IconSettings,
  visibility: Ellipsis,
  newChat: PenLine,
} as const;
