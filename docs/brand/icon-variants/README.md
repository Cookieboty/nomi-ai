# Nomi 应用图标变体

原创矢量（MIT，与仓库同许可），由 `scripts/brand/build-app-icon.py` 生成，
`scripts/brand/render-icons.mjs`（Electron 自带 Chromium）栅格化。依据品牌板：流畅曲线 N +
橙色四角星光，配色 `#FB9466` / 奶油 `#FFF6EC` / 深棕 `#33291F`。

| 变体                | 底色     | N    | 星光 | 说明                                                      |
| ------------------- | -------- | ---- | ---- | --------------------------------------------------------- |
| A · cream           | 奶油渐变 | 深棕 | 橙   | 品牌板主视觉；在浅色 Dock / 任务栏上边界弱                |
| **B · ink（默认）** | 深棕渐变 | 奶油 | 橙   | 与默认主题 Warm Ink 一致；深浅背景都清楚，16px 仍可辨     |
| C · sunset          | 橙渐变   | 奶油 | 深棕 | 最醒目；用作 Windows / Linux 托盘图标（深浅任务栏都可见） |

文件：

- `nomi-<变体>-mac.svg`：Apple 图标网格（1024 画布，824 连续曲率圆角矩形，四周 100px 留白）→ `icon.icns`
- `nomi-<变体>-flat.svg`：满版圆角（22%）→ `icon.ico`（≥64px）、`icons/*.png`、`icon.png`
- `nomi-<变体>-flat-small.svg`：加粗笔画、星光放大的小号版本 → 16 / 24 / 32 / 48px
- `nomi-tray-template.svg`：macOS 托盘模板图（纯黑 + alpha，系统自动反色）
- `nomi-tray-color.svg`：Windows / Linux 托盘（sunset 小号）

重新生成：

```bash
python3 scripts/brand/build-app-icon.py
# 然后见 scripts/brand/render-icons.mjs 顶部注释（electron 栅格化），再用 Pillow 打包 ico / icns
```

`preview.png` 为三种变体在浅 / 深背景下 1024 → 16px 的对照。

## 运行时切换的 Windows .ico（#56）

`packages/electron/assets/app-icons/<变体>/app.ico`（16 / 24 / 32 / 48 用 `-flat-small.svg`，64 / 128 / 256 用 `-flat.svg`）
供运行时 `win.setAppDetails({ appId, appIconPath })` 设置任务栏按钮图标（System.AppUserModel.RelaunchIconResource）。
打包后随 `extraResources` 复制到 `resources/assets`，在磁盘上（Windows Shell 读不了 asar）。重新生成：

```bash
python3 scripts/brand/build-variant-ico.py   # 需要 Pillow + headless Chrome / Chromium
```

能立即更新：所有窗口图标、正在运行的任务栏按钮、托盘、macOS Dock。
已固定到任务栏的图标由 Windows 图标缓存决定，通常重启应用后才更新（个别情况需取消固定后重新固定）；
安装包 / 可执行文件 / 开始菜单与桌面快捷方式始终是打包时嵌入的 ink。
