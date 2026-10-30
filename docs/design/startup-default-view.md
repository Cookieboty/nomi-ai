# 启动默认界面 · Startup default view

状态：已实现（v1.0.4）。Status: implemented in v1.0.4.

## 中文

### 背景

启动 Nomi 后一直是先出现诺米，要进软件主界面（对话窗口）得点诺米的「AI 对话」。有定时任务 / 自动化的用户喜欢这样；但主要在主界面里工作的用户（尤其 Windows）希望一启动就进主界面。所以做成可选，**默认保持现状**。

### 术语（代码里的历史命名）

| 用户看到的 | 代码里                               | 说明                                                                 |
| ---------- | ------------------------------------ | -------------------------------------------------------------------- |
| 诺米       | `WindowManager.createMainWindow()`   | 透明置顶窗口，承载气泡 / 提醒 / 编程助手进度播报；关闭它 = 退出 Nomi |
| 软件主界面 | `WindowManager.createAiChatWindow()` | 对话窗口（含设置、引导）；关闭它不会退出，诺米继续运行               |

### 设置

- key：`startup.defaultView`，取值 `'mascot' | 'main'`，默认 `'mascot'`。
- 存储：`userData/startup.json`（`{"defaultView":"main"}`），与 `theme.json`、`locale.json` 同类的独立小文件，由主进程 `StartupService` 读写。
- IPC：`ai:startup:get` / `ai:startup:set`（走 `guardedHandle`，校验 sender；非法值抛错，不落盘）。
- 迁移 / 默认：文件不存在、损坏或值未知 → `'mascot'`。老用户升级后没有该文件，行为完全不变，**无需写迁移**；已完成引导的老用户不会再看到引导。

### 启动行为（`planStartup`，纯函数，见 `startup/startupPlan.ts`）

| 条件                           | 诺米窗口           | 主界面                               |
| ------------------------------ | ------------------ | ------------------------------------ |
| 首次引导未完成（与设置值无关） | 正常显示           | 1.5 秒后打开并聚焦（引导在主界面里） |
| `mascot`（默认）               | 正常显示           | 不自动打开（历史行为）               |
| `main`                         | 显示但**不抢焦点** | 诺米与托盘就绪后立即打开并聚焦       |

要点：

- **诺米始终创建**。定时任务、提醒、编程助手进度、用量提醒都通过诺米气泡 / 灵动岛播报，`main` 模式下它仍在桌面后台待命，自动化不受影响。`main` 模式下它以 `showInactive` 出现，保证最后获得焦点的是主界面（Windows 上透明置顶窗口的 `show()` 会抢焦点）。
- 主界面窗口打开失败只记日志，不影响启动，用户仍有诺米可用。
- 系统登录项 / 开机自启拉起时与普通启动完全一致：`main` 模式下主界面同样到前台并获得焦点（v1.0.4 用户反馈后取消了早先「自启不抢焦点」的特例）。

### 再次唤起已运行的实例

`mascot` 模式保持历史行为（聚焦已有窗口）。`main` 模式下把主界面带到前台（已最小化则还原）：

- 第二实例启动（`second-instance`，含 `nomi://` deep link）；
- macOS 点 Dock 图标（`activate`，仅在启动完成后响应）；
- Windows 左键点托盘图标（macOS 点托盘会弹菜单，保持原样；托盘右键菜单里的「打开 AI 对话」始终可用）。

### 界面

- 设置 → 通用 → 语言下方：「启动 Nomi 后默认显示」单选：**诺米**（默认）/ **软件主界面**，点选即保存，下次启动生效；保存失败回滚。
- 首次引导新增第 3 步「启动 Nomi 后先看到什么？」：**以诺米方式打开**（默认选中）/ **以控制台（主界面）方式打开**。点选即写入同一个设置（中途跳过整个引导也保留已选）；该步可「跳过这一步」，跳过 = 保持默认。从设置里重新打开引导时预选当前值。
- 选中态沿用最新令牌：`--cd-color-selected-bg` + `--cd-color-selected-text`（深棕字 + 暖橙淡底）+ `--cd-color-accent-strong` 边框，不使用 accent 作文字色。

### 关闭主界面时（`closeMain`）

- 与 `defaultView` 存在同一个 `startup.json`：`closeMain = 'hide' | 'quit'`，默认 `'hide'`；老文件没有该字段 → `'hide'`。
- **隐藏到托盘（默认，历史行为）**：关闭主界面只销毁对话窗口，诺米、托盘和后台服务（定时任务 / 提醒）继续运行。
- **退出 Nomi**：主界面窗口 `closed` 后发出 `app:quit`，走统一退出流程（`before-quit` → 停止后台服务 → 销毁托盘 → 关闭诺米 → `app.exit(0)`）。已在退出流程中（`shutdown.isQuitting()`）时不重复触发。
- macOS：⌘Q 与托盘「退出」始终完全退出；红色关闭按钮与 ⌘W 都是「关闭窗口」，按本设置处理（选了「退出 Nomi」就退出，默认则只关窗口）。这是用户在设置里明确选择的行为，所以不套用 macOS「关窗不退出」的惯例。
- 设置 → 通用里紧挨「启动 Nomi 后默认显示」，立即生效（无需重启）。

### 边界与取舍

- Linux 托盘左键不做处理（按用户决定保持现状）。
- 不改动诺米动画 / Rive 资源。
- 没有给 Linux 托盘加左键处理（Linux 托盘 click 事件不可靠）。
- 启动阶段的另一件事：语音已开但离线 TTS 模型缺失时（老用户升级），主进程在后台下载模型，不弹窗、不影响默认界面，见 [tts-on-demand.md](./tts-on-demand.md)。

## English

### Summary

Nomi has always started with the mascot; opening the main window (the chat window) took a click on her “AI chat”. Users who rely on scheduled tasks like that, but people who mostly work in the main window (especially on Windows) want to land there directly. We add a setting and **keep the current behavior as the default**.

### Setting

- Key `startup.defaultView` = `'mascot' | 'main'`, default `'mascot'`, persisted by the main-process `StartupService` in `userData/startup.json`; IPC `ai:startup:get` / `ai:startup:set`.
- A missing, corrupted or unknown value falls back to `'mascot'`, so existing users keep today's behavior without a migration.

### Launch behavior

- `mascot` (default): unchanged — only the mascot appears.
- `main`: the mascot window is still created (scheduled tasks, reminders and coding-agent notifications are announced through it) but shown without taking focus; the main window opens right after the mascot and the tray are ready and takes focus.
- Launches from an OS login item behave exactly like a normal launch: in `main` mode the main window comes to the front with focus.
- First-run onboarding always wins (it lives in the main window), regardless of the setting.
- Re-activating a running instance (second launch, macOS Dock click, Windows tray left-click) raises the main window in `main` mode; `mascot` mode keeps the old behavior.
- If the main window fails to open the error is logged and the mascot stays usable.

### When closing the main window

- `closeMain = 'hide' | 'quit'` in the same `startup.json`, default `'hide'` (today's behavior: only the chat window closes, the mascot, tray and background services keep running).
- `'quit'`: closing the main window runs the normal quit path, so the mascot, the tray and all services shut down. On macOS ⌘Q and the tray “Quit” always quit; the red button and ⌘W follow the setting.

### UI

- Settings → General → “Show on startup”: Mascot (default) / Main window; “When closing the main window”: Hide to tray (default) / Quit Nomi.
- Onboarding step 3 “What should you see when Nomi starts?”: Open with the mascot (default) / Open with the console (main window). The choice is saved immediately, the step is skippable, and skipping keeps the default.

Related: when voice is on but the offline TTS model is missing (users upgrading from ≤1.0.3), startup downloads it in the background without opening any window; see [tts-on-demand.md](./tts-on-demand.md).

## 桌面诺米显示开关（#55）

- 设置 → 通用 → 桌面角色「显示诺米」与诺米工具栏「关闭诺米」随时可用，持久化在 `startup.json` 的 `showMascot`。
- 关闭：诺米窗口隐藏并整窗静音，朗读入口跳过，唤醒词 / 免按键常驻监听停止（不在看不见的窗口里开麦）；提醒仍走系统通知与灵动岛。
- 默认界面为诺米时关闭她：主进程把 `defaultView` 改为 `main`（同一次写盘，`ai:startup:changed` 广播），设置页提示「启动后默认显示已改为软件主界面」；主界面没打开 / 被藏起时立即打开它，保证不会进入无界面状态。
- 同一个补丁里同时 `defaultView: 'mascot'` 与 `showMascot: false` 视为矛盾，拒绝且不落盘；单独选「桌面角色」为默认界面会重新打开她。
