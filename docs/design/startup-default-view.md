# 启动默认界面 · Startup default view

状态：已实现（v1.0.4）。Status: implemented in v1.0.4.

## 中文

### 背景

启动 Nomi 后一直是先出现看板娘，要进软件主界面（对话窗口）得点看板娘的「AI 对话」。有定时任务 / 自动化的用户喜欢这样；但主要在主界面里工作的用户（尤其 Windows）希望一启动就进主界面。所以做成可选，**默认保持现状**。

### 术语（代码里的历史命名）

| 用户看到的 | 代码里                               | 说明                                                                 |
| ---------- | ------------------------------------ | -------------------------------------------------------------------- |
| 看板娘     | `WindowManager.createMainWindow()`   | 透明置顶窗口，承载气泡 / 提醒 / 编程助手进度播报；关闭它 = 退出 Nomi |
| 软件主界面 | `WindowManager.createAiChatWindow()` | 对话窗口（含设置、引导）；关闭它不会退出，看板娘继续运行             |

### 设置

- key：`startup.defaultView`，取值 `'mascot' | 'main'`，默认 `'mascot'`。
- 存储：`userData/startup.json`（`{"defaultView":"main"}`），与 `theme.json`、`locale.json` 同类的独立小文件，由主进程 `StartupService` 读写。
- IPC：`ai:startup:get` / `ai:startup:set`（走 `guardedHandle`，校验 sender；非法值抛错，不落盘）。
- 迁移 / 默认：文件不存在、损坏或值未知 → `'mascot'`。老用户升级后没有该文件，行为完全不变，**无需写迁移**；已完成引导的老用户不会再看到引导。

### 启动行为（`planStartup`，纯函数，见 `startup/startupPlan.ts`）

| 条件                           | 看板娘窗口         | 主界面                               |
| ------------------------------ | ------------------ | ------------------------------------ |
| 首次引导未完成（与设置值无关） | 正常显示           | 1.5 秒后打开并聚焦（引导在主界面里） |
| `mascot`（默认）               | 正常显示           | 不自动打开（历史行为）               |
| `main`                         | 显示但**不抢焦点** | 看板娘与托盘就绪后立即打开并聚焦     |
| `main` + 系统登录项自动启动    | 显示但不抢焦点     | 打开但**不抢焦点**（`showInactive`） |

要点：

- **看板娘始终创建**。定时任务、提醒、编程助手进度、用量提醒都通过看板娘气泡 / 灵动岛播报，`main` 模式下它仍在桌面后台待命，自动化不受影响。`main` 模式下它以 `showInactive` 出现，保证最后获得焦点的是主界面（Windows 上透明置顶窗口的 `show()` 会抢焦点）。
- 主界面窗口打开失败只记日志，不影响启动，用户仍有看板娘可用。
- 「开机自启」判定用 `app.getLoginItemSettings().wasOpenedAtLogin`（仅 Windows / macOS 有值，Linux 视为否）。应用目前没有自带的开机自启开关，这条只对用户在系统里自行添加的登录项生效。

### 再次唤起已运行的实例

`mascot` 模式保持历史行为（聚焦已有窗口）。`main` 模式下把主界面带到前台（已最小化则还原）：

- 第二实例启动（`second-instance`，含 `nomi://` deep link）；
- macOS 点 Dock 图标（`activate`，仅在启动完成后响应）；
- Windows 左键点托盘图标（macOS 点托盘会弹菜单，保持原样；托盘右键菜单里的「打开 AI 对话」始终可用）。

### 界面

- 设置 → 通用 → 语言下方：「启动 Nomi 后默认显示」单选：**看板娘**（默认）/ **软件主界面**，点选即保存，下次启动生效；保存失败回滚。
- 首次引导新增第 3 步「启动 Nomi 后先看到什么？」：**以看板娘方式打开**（默认选中）/ **以控制台（主界面）方式打开**。点选即写入同一个设置（中途跳过整个引导也保留已选）；该步可「跳过这一步」，跳过 = 保持默认。从设置里重新打开引导时预选当前值。
- 选中态沿用最新令牌：`--cd-color-selected-bg` + `--cd-color-selected-text`（深棕字 + 暖橙淡底）+ `--cd-color-accent-strong` 边框，不使用 accent 作文字色。

### 边界与取舍

- 没有新增「关闭主界面后是否退出 / 常驻托盘」设置；`main` 模式下关闭主界面，Nomi 仍以看板娘 + 托盘运行（与现有行为一致）。
- 不改动看板娘动画 / Rive 资源。
- 没有给 Linux 托盘加左键处理（Linux 托盘 click 事件不可靠）。

## English

### Summary

Nomi has always started with the mascot; opening the main window (the chat window) took a click on her “AI chat”. Users who rely on scheduled tasks like that, but people who mostly work in the main window (especially on Windows) want to land there directly. We add a setting and **keep the current behavior as the default**.

### Setting

- Key `startup.defaultView` = `'mascot' | 'main'`, default `'mascot'`, persisted by the main-process `StartupService` in `userData/startup.json`; IPC `ai:startup:get` / `ai:startup:set`.
- A missing, corrupted or unknown value falls back to `'mascot'`, so existing users keep today's behavior without a migration.

### Launch behavior

- `mascot` (default): unchanged — only the mascot appears.
- `main`: the mascot window is still created (scheduled tasks, reminders and coding-agent notifications are announced through it) but shown without taking focus; the main window opens right after the mascot and the tray are ready and takes focus.
- `main` launched by an OS login item: the main window opens with `showInactive` so it does not steal focus.
- First-run onboarding always wins (it lives in the main window), regardless of the setting.
- Re-activating a running instance (second launch, macOS Dock click, Windows tray left-click) raises the main window in `main` mode; `mascot` mode keeps the old behavior.
- If the main window fails to open the error is logged and the mascot stays usable.

### UI

- Settings → General → “Show on startup”: Mascot (default) / Main window.
- Onboarding step 3 “What should you see when Nomi starts?”: Open with the mascot (default) / Open with the console (main window). The choice is saved immediately, the step is skippable, and skipping keeps the default.
