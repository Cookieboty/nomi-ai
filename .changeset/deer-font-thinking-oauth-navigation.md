---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

fix(chat): 增加会话正文字号设置并对齐排版；修复 thinking 生命周期与 Home / End 定位，远程 MCP 支持浏览器 OAuth 授权及凭据自动刷新。

对话字体： 会话正文字号可在“设置 → 通用 → 外观”中按 10–20px 调整，默认 14px 并即时保存；输入框、代码和工具控件固定 14px，辅助信息固定 13px；Windows / Linux 的普通界面字号仍按平台适配；Home / End 支持逻辑行首尾、Shift 选区和 Ctrl / Command 全文定位，保留输入法行为。

fix(ai): 补齐 thinking 开始与结束事件，支持空明细状态并在输出、失败或中止后结束；普通对话只展示执行状态与轨迹时序，编程助手思考明细保持原有行为。

feat(mcp): 远程 MCP 支持浏览器 OAuth 授权、PKCE、凭据加密保存与自动刷新，以及授权取消和清除；手动 Authorization 请求头不变，旧授权与连接结果不会覆盖修改后的服务配置。
