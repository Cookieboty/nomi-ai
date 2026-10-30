/**
 * 首次启动引导：语言 → 主题 → 启动方式 → 角色与声音 → 称呼与语气 → 职业与兴趣 → 供应商 → 隐私说明。
 * 每一步都可跳过；完成 / 跳过后不再自动弹出，可在「设置 → 通用」重新打开。
 * 引导界面在对话窗口里，主进程负责：是否已完成、首次启动时打开窗口、转发桌面角色指令（打招呼 / 换角色 / 试听声音），
 * 以及保存「职业与兴趣」（渲染进程据此推荐任务；重新引导、完成都保留）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { isSemanticGesture } from '@nomi-ai/character-contract';
import { normalizeUserProfile, type UserProfile } from '@nomi-ai/types';

import { avatarGesture, publishAvatarCue, sendMascotCommand } from '../ai/mascotCommand';
import type { AppEvents } from '../core/appEvents';

export interface OnboardingState {
  done: boolean;
  skipped?: boolean;
  completedAt?: number;
  profile?: UserProfile;
}

/** 引导里允许转发给桌面角色的指令（不开放任意指令） */

export interface OnboardingDeps {
  userData: string;
  /** 打开对话窗口（引导显示在里面） */
  openChat: () => void | Promise<void>;
  events: AppEvents;
  /**
   * 宿主当前存活的窗口数（Electron：没销毁的 BrowserWindow）；桌面角色指令只在有窗口时算送达。
   * 缺省（无界面宿主、单测）按 0 算。
   */
  liveWindows?: () => number;
}

export class OnboardingService {
  private state: OnboardingState;
  private readonly file: string;

  constructor(private readonly deps: OnboardingDeps) {
    this.file = path.join(deps.userData, 'onboarding.json');
    this.state = this.load();
  }

  private load(): OnboardingState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as OnboardingState;
      return {
        done: raw.done === true,
        skipped: raw.skipped,
        completedAt: raw.completedAt,
        ...(raw.profile ? { profile: normalizeUserProfile(raw.profile) } : {}),
      };
    } catch {
      // 老用户升级：已经有供应商配置或记忆数据，视为已完成，不打扰
      const existing = ['ai-providers.json', 'memory'].some((f) =>
        fs.existsSync(path.join(this.deps.userData, f)),
      );
      return { done: existing };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }

  get(): OnboardingState {
    // CD_ONBOARDING=off（e2e）：视为已完成，界面不显示引导
    if (process.env.CD_ONBOARDING === 'off') return { ...this.state, done: true };
    return { ...this.state };
  }

  complete(skipped = false): OnboardingState {
    this.state = { ...this.keep(), done: true, skipped, completedAt: Date.now() };
    this.save();
    return this.get();
  }

  /** 设置里「重新打开新手引导」 */
  async reopen(): Promise<OnboardingState> {
    this.state = { ...this.keep(), done: false };
    this.save();
    await this.deps.openChat();
    this.deps.events.publish('onboarding.show', this.get());
    return this.get();
  }

  /** 完成 / 重新引导时要保留的字段 */
  private keep(): Pick<OnboardingState, 'profile'> {
    return this.state.profile ? { profile: this.state.profile } : {};
  }

  profile(): UserProfile {
    return normalizeUserProfile(this.state.profile);
  }

  /** 保存职业与兴趣，并通知所有窗口（侧栏清单、欢迎页随之更新） */
  setProfile(v: unknown): UserProfile {
    const profile = normalizeUserProfile(v);
    this.state = { ...this.state, profile };
    this.save();
    this.deps.events.publish('onboarding.profileChanged', profile);
    return profile;
  }

  /** 首次启动：未完成则打开对话窗口显示引导。CD_ONBOARDING=off 可关闭（e2e） */
  shouldAutoOpen(): boolean {
    if (process.env.CD_ONBOARDING === 'off') return false;
    return !this.state.done;
  }

  /**
   * 对话窗口 → 桌面角色：说一句（可带语义手势）、语义手势、正在等回复。只转发语义名（§10.5），
   * 资源名与其它指令一律拒绝。返回是否有桌面角色窗口收到。
   */
  mascot(cmd: unknown): boolean {
    if (!cmd || typeof cmd !== 'object') return false;
    const c = cmd as {
      type?: unknown;
      text?: unknown;
      gesture?: unknown;
      name?: unknown;
      phase?: unknown;
    };
    switch (c.type) {
      case 'say': {
        if (typeof c.text !== 'string') return false;
        const gesture = isSemanticGesture(c.gesture) ? c.gesture : undefined;
        sendMascotCommand(this.deps.events, {
          type: 'say',
          text: c.text,
          ...(gesture ? { gesture } : {}),
        });
        return this.delivered();
      }
      case 'gesture':
        if (!isSemanticGesture(c.name)) return false;
        avatarGesture(this.deps.events, c.name);
        return this.delivered();
      case 'reply':
        if (c.phase !== 'waiting' && c.phase !== 'settled') return false;
        publishAvatarCue(this.deps.events, { type: 'reply', phase: c.phase });
        return this.delivered();
      default:
        return false;
    }
  }

  /** 桌面角色指令只在宿主有存活窗口时算送达 */
  private delivered(): boolean {
    return (this.deps.liveWindows?.() ?? 0) > 0;
  }
}
