# 自动化与桌面能力

Nomi 可以在你授权的范围内替你动手：读写文件、设提醒、读写剪贴板、在工作区里跑命令、运行一小段代码。每一步都检查权限、写入审计日志，改动类操作可以撤销。

设置入口：「设置 → Nomi → 桌面权限」，或托盘「桌面能力（文件授权 / 操作记录）…」。

## 文件

- **授权文件夹**：通过系统选择框授权（只读或读写），也可以只授权单个文件。默认什么都访问不了。
- 然后直接说：「帮我总结 ~/Documents/report.pdf」「找一下提到 invoice 的文件」。Nomi 可以列出、搜索、读取、总结、编辑、复制、移动 txt、md、pdf、docx 等文件。
- **Nomi 对话的工作区**：新对话的输入框上方可以给每个 Nomi 对话选一个工作区（新对话默认「文稿/nomi」）。工作区里的文件不需要另外授权，见 [隐私与安全](privacy-security.md#权限与确认)。
- **请 Nomi 访问新文件夹**：Nomi 需要工作区外的文件夹时，对话里会出现「请求访问文件夹」卡片，写明位置和读 / 写：点「授权」直接生效，「选择其他文件夹…」打开系统选择框。不存在、不是文件夹或范围太宽（主目录、系统目录、敏感目录等）的位置只能自己选。
- **确认**：需要你同意时，对话窗口开着就在输入栏上方显示授权卡片（允许 / 拒绝 / 这个对话里不再询问这类操作 / 查看工具、参数和预演结果）；对话窗口没开时由诺米弹出气泡。破坏性操作和第一次发给云端的确认会直接展开详情，出现 1 秒后才能确认（防误触），120 秒没答复视为拒绝。
- **撤销**：删除只会移到应用回收站（保留 30 天）；「桌面权限 → 可撤销的操作」里可以一步步撤销 Nomi 改过的文件。
- **始终拒绝**：`.ssh`、`.gnupg`、云凭据目录、钥匙串、浏览器配置、`.env`、私钥文件（如 `id_rsa`、`*.kdbx`）以及应用自己的数据目录，即使在授权文件夹内也不行。
- **受保护的文件夹**：「桌面权限 → 隐私保护」里可以自己加文件夹（财务、证件这类），和上面的内置清单一样，即使在授权文件夹内也不行；编程助手也不能在里面工作，在系统沙箱里也读写不了。取消保护要先确认。

## 命令

Nomi 可以在对话工作区里跑命令（`workspace_run`）。命令以你的身份运行，**不限于工作区**；要不要你确认由「命令自动审核」和「命令白名单」决定，见 [隐私与安全](privacy-security.md#权限与确认)。

## 提醒与剪贴板

- **提醒**：见 [日程与任务](scheduling-calendar.md)。
- **剪贴板**：Nomi 可以读取或写入当前剪贴板（`clipboard_read` / `clipboard_write`），默认每次运行第一次用时先问你。

## 受控浏览器（暂不可用）

工具列表与「工具权限」里还能看到受控浏览器的工具（打开网页、读取页面等），但当前版本没有接上浏览器，Nomi 调用时会得到
「当前环境没有受控浏览器」。要让 Nomi 读网页、操作网页，在「扩展 / MCP」里添加 Playwright 或 Chrome DevTools 预设（见 [MCP 与技能](mcp-skills.md)）。

## 桌面操作（Computer Use）

Nomi 可以替你操作本机的应用（访达、备忘录、系统设置等）：先读应用界面的无障碍树（每个按钮、输入框都有一个编号），再按编号点击、输入、按快捷键、滚动。默认不移动真实鼠标、不抢焦点。

- **准备**：在「设置 → Computer Use」里点「安装」，Nomi 用 npm 安装 [agent-desktop](https://github.com/vercel-labs/agent-desktop)（开源，Apache-2.0；需要 Node.js 18 或更新版本）。npm 全局目录不可写时可以改装到用户目录。同一页可以「检查更新」并更新；只装适配过的大版本（目前 1.x），出了新的大版本只提示、不自动装。macOS 要在「系统设置 → 隐私与安全性 → 辅助功能」里允许**启动 agent-desktop 的应用**，截图还要「屏幕录制」：macOS 把这两个权限算在启动它的应用头上，从 Nomi 里调用时是 Nomi（开发时是运行 `pnpm dev` 的终端），只给 agent-desktop 本身授权不够。设置页会写明该允许哪个应用，能看到授权状态、打开授权引导；授权后点「重新检查」即可，不用重启。没装时这组工具不会提供给模型。自己装的（`brew install agent-desktop` 等）也认，也可以用环境变量 `NOMI_AGENT_DESKTOP` 指定可执行文件。
- **编程助手**：装了 agent-desktop 后（「设置 → Computer Use → 允许编程助手使用」，默认打开），新启动的 Claude Code、Codex 和 Gemini 等 ACP 编程助手会话会带上 `nomi-computer` 这个 MCP 服务器，可以用同一组工具操作应用（比如改完代码后自己打开应用点一遍）。确认卡片上会写明是哪个编程助手请求的，确认、审计和不能操作的应用与对话里相同；「这个对话里不再询问」按编程助手标签记。编程助手的操作在等你确认时，Agent 看板上这个标签显示为「等你处理」。编程助手在计划模式下只能读界面。默认打开（装了 agent-desktop 才注入）；不想让编程助手用，在「设置 → Computer Use」里关掉，之后新启动的会话生效。
- **确认**：第一次读取应用界面、第一次操作时会问你。点「允许」放行这一次，并且这个对话里后面的桌面操作都自动执行（编程助手按它的标签算一个对话）；点「始终允许」（或在「设置 → Computer Use」里打开「自动执行桌面操作」），以后所有对话里的桌面操作都自动执行，读过界面后也不再逐步确认，可以随时关掉。付款、发送、删除、提交、系统设置里的改动、只有图标没有名字的按钮，以及回车、⌘↩ 这类可能直接发送的快捷键和退出 / 关闭窗口的快捷键（⌘Q、⌘W、Ctrl+Q、Ctrl+W 等），每次都弹窗确认；按屏幕坐标点击会移动真实鼠标，每次都要确认，而且落在密码 / 支付类应用或 Nomi 自己窗口上的坐标直接拒绝；输入栏选了「逐项确认」时照样逐项问。
- **操作后回读**：点击、输入、按键、滚动之后默认再读一次同一个应用的界面（较短的一段），模型据此确认结果、拿到新的编号；不需要时模型可以关掉。
- **视觉兜底**：画布、游戏、远程桌面、自绘界面这类读不到元素的地方，在「设置 → Computer Use」里选一个能看图的模型后，Nomi 会截图交给它定位目标，返回屏幕坐标，再按坐标点击（会移动真实鼠标）。每次截图发送前都会问你；开了「仅本地模型可读文件」时只能用本地视觉模型。阿里云百炼 GUI-Plus 这类专门做界面定位的模型效果更好。
- **紧急停止**：有操作在进行时，对话窗口底部（对话列上方）会出现「正在操作桌面 · 停止」；被操作的应用在前台时按系统级快捷键（默认 ⌘⇧. / Ctrl+Shift+.，在「设置 → Computer Use」里可以换或关掉）。停止会取消正在执行的桌面操作、撤掉还在等的桌面操作确认卡，并中止正在操作桌面的那一轮（Nomi 的对话、编程助手的标签）；这一轮之后的桌面操作一律被拒，直到你发下一条消息。灵动岛上不显示「正在操作」。
- **隔离模式**（macOS，Apple Silicon；需要带 `sandbox` 命令的 agent-desktop 版本，1.2.0 还没有，没有时设置页不显示这一项）：在设置里选一个 agent-desktop 沙箱后，所有桌面操作都在这台独立的 macOS 虚拟机里进行，不碰你的桌面。沙箱要先在终端里创建（`agent-desktop sandbox install macos`，再 `agent-desktop sandbox create <名字> --provider macos --set ipsw=latest`），第一次启动后在虚拟机里打开远程登录并授权辅助功能；设置页可以启动、停止沙箱。
- **不能操作**：密码管理器、钥匙串、银行和支付类应用，以及 Nomi 自己的窗口；在「设置 → Computer Use → 禁止操作的应用」里还可以再加（只能加，不能放开内置的）。
- **隐私**：界面内容只在这一轮发给当前模型（开了「仅本地模型可读文件」时云端模型读不到）；可以在设置里打开「读界面时隐去输入框内容」，输入框里的文字只给出字数。截图只保存在本机 `userData/desktop/screenshots/`，只有视觉兜底时（经你确认）才发给视觉模型。输入的文字不进命令行参数（隔离模式下也一样：沙箱命令不转发标准输入时输入会失败，而不会把文字放进参数），审计日志只记哈希与长度；编程助手发起的操作在操作记录里标为 `cli:<编程助手名>`。
- **限制**：只在前台对话里可用，后台任务不能操作桌面；Linux 的 Wayland 会话只支持读界面和按编号操作，不能截图和按坐标点击；Electron、游戏、自绘界面可能读不到元素。

## 代码沙箱

Nomi 可以运行一小段 JavaScript 或 Python，每次都要在对话框里看过代码再确认。代码只能读写本次的临时目录，超时自动终止（默认 15 秒，最长 60 秒），运行后删除临时目录，环境变量里不带任何 API Key。

## 工具权限

「桌面权限 → 工具权限」里可以把每个读写类工具设为：总是允许 / 每次运行首次询问 / 每次都询问。破坏性工具和代码运行固定为每次确认。Nomi 对话输入栏的权限模式（计划 / 逐项确认 / 自动改文件 / 自动）也会影响多久问一次，见 [隐私与安全](privacy-security.md#权限与确认)。

## 操作记录

每次调用桌面工具的时间、结果与参数（只记参数的哈希与长度）都写进审计日志，保留最近 30 天，在「桌面权限 → 操作记录」里分页查看。「清除全部桌面能力数据」会删除所有授权、工具权限设置与操作记录。

## 实现

- 内核：`apps/desktop-go/internal/core/desktop`（授权与路径检查 `path_guard.go`、确认 `permission_broker.go` / `consent.go`、审计 `audit_log.go`、撤销 `undo_journal.go`、回收站 `app_trash.go`、命令审核 `command_review.go`），工具定义 `internal/ai/runtime/igtools`。
- 文件解析在受限的子进程里进行（`internal/core/desktop/parse`）。读工作区与授权文件夹里的文件不算外部内容；一轮对话读过网页、命令输出、MCP 返回等外部内容后，同一轮里的写操作会再次确认，防止这些内容诱导模型改文件（可以点「始终允许」，这个对话里不再询问）。
- 代码沙箱：`apps/desktop-go/internal/core/sandbox`。JavaScript 用本机 Node 的权限模型（`node --permission`，只能读写临时目录）；Python 优先用系统沙箱（macOS `sandbox-exec` / Linux `bwrap`），不可用或在 Windows 上时回落 `python3 -I`，结果里会标明，见 [安全边界](../development/security.md#代码执行沙箱)。
- 桌面操作：执行器 `apps/desktop-go/internal/core/computer`（调用 agent-desktop CLI、解析 JSON 结果、ref 缓存、界面变化后按角色和名字重新定位一次、应用黑名单与敏感动作判定 `guard.go`、安装与更新检查 `install.go`、设置 `settings.go`、谁在操作与紧急停止 `activity.go`、视觉定位 `vision.go`、隔离沙箱 `sandbox.go`、契约 `computer.*` 的处理函数 `register.go`），视觉模型经网关调用 `internal/core/gwstore/vision.go`，紧急停止的装配（中止对话、撤确认卡、编程助手标签下一轮才解除）`apps/desktop-go/computer_wiring.go`，系统级快捷键经外壳的 `shell.GlobalShortcuts`（Wails `GlobalShortcutManager`），工具 `internal/ai/runtime/igtools/deskcomputer.go`，装配 `apps/desktop-go/computer_wiring.go`，设置页 `packages/ai-chat/src/components/SettingsView/ComputerSection.tsx` 与 `ComputerOptions.tsx`，对话窗口的停止条 `packages/ai-chat/src/components/ComputerActivityBar`。
- 给编程助手的 MCP：`internal/core/computer/mcpserve`。内核在 `127.0.0.1` 上开一个只接受 POST 的端点（校验 Host、拒绝带 Origin 的浏览器请求），每个编程助手标签一个随机 token，写在 `userData/harness/computer-mcp/` 下的 0600 文件里（每次启动清空，标签关闭时作废；系统沙箱只放行读这个标签自己的那一个文件，别的标签读不到）。编程助手按 stdio MCP 启动 `<Nomi 可执行文件> --computer-mcp <token 文件>`，这个进程不起界面，只把 stdio 转发到端点；token 不进命令行参数和编程助手的配置。注入在 `internal/core/cli/harness/computer_mcp.go`（Claude Code `--mcp-config` 并预先放行这些工具，确认在 Nomi 里做；Codex `-c mcp_servers.nomi-computer.*`；ACP `session/new` 的 `mcpServers`），系统沙箱单独放行读 token 目录。
- 数据保存在 `userData/desktop/`（设置、审计日志、操作记录、回收站、截图）。
