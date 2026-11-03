# 第三方供应商链接接入（`nomi://provider/*`）

第三方供应商（中转站、模型平台）在自己的网页上放一个按钮，用户点一下就把供应商加进 Nomi 的网关。
两种接入方式，最后都停在 Nomi 里的确认框上：**用户点确认之前，什么都不会写入**。

| 方式       | 链接                                   | 适合                                              | Key 是否出现在链接里  |
| ---------- | -------------------------------------- | ------------------------------------------------- | --------------------- |
| A 直接导入 | `nomi://provider/import?v=1&data=…`    | 中转站「一键填入」，几行模板就能接                | 是                    |
| B 授权连接 | `nomi://provider/connect?v=1&issuer=…` | 有账号体系、愿意多做一个授权页与换 Key 接口的平台 | 否（PKCE 授权码换取） |

业内参考：Cherry Studio 的 `cherrystudio://providers/api-keys?v=1&data=<base64>`（A 档兼容它的字段）、
CC Switch 的 `ccswitch://v1/import`、Cursor / VS Code 安装 MCP 的 base64 负载链接、OpenRouter 的 PKCE 授权（B 档）。

## A：直接导入

```
nomi://provider/import?v=1&data=<base64url(UTF-8 JSON)>
```

`data` 用 base64url（`+/` 换成 `-_`，可以不带 `=`）；普通 base64 也接受。JSON：

```jsonc
{
  "name": "Example AI", // 必填，1–64 字
  "homepage": "https://example.com", // 可选：确认框里显示
  "urls": {
    // 至少填一个；与 Nomi 网关的四种协议对应
    "chat": "https://api.example.com/v1", // OpenAI Chat Completions
    "responses": "https://api.example.com/v1", // OpenAI Responses
    "messages": "https://api.example.com", // Anthropic Messages
    "gemini": "https://api.example.com/gemini", // Gemini
  },
  "key": "sk-…", // 必填
  "models": ["claude-sonnet-5-5", "gpt-5"], // 可选：预填的模型
}
```

兼容 Cherry Studio 的扁平写法：`{ "name", "baseUrl", "apiKey", "type"? }`。`type` 为 `anthropic` 时
`baseUrl` 当作 `messages`，`gemini` 当作 `gemini`，其余当作 `chat`。

中转站模板示例（New API 等「聊天链接」里填）：

```
nomi://provider/import?v=1&data={base64 of {"name":"Example AI","baseUrl":"{address}/v1","apiKey":"{key}"}}
```

## B：授权连接

1. 网页放链接 `nomi://provider/connect?v=1&issuer=https://example.com`（`issuer` 只能是 https 源，不带路径）。
   用户也可以在 Nomi 的「添加第三方供应商」里填域名发起。
2. Nomi 读 `https://example.com/.well-known/nomi-provider.json`：

   ```jsonc
   {
     "version": 1,
     "name": "Example AI",
     "homepage": "https://example.com",
     "urls": { "chat": "https://api.example.com/v1", "messages": "https://api.example.com" },
     "models": ["…"], // 可选
     "authorization_endpoint": "https://example.com/nomi/authorize",
     "token_endpoint": "https://example.com/api/nomi/token",
   }
   ```

   两个端点必须是 https，且主机是 `issuer` 的主机或它的子域名。

3. 用户在 Nomi 里确认后，Nomi 用系统浏览器打开：

   ```
   {authorization_endpoint}?response_type=code&client_id=nomi
     &redirect_uri=nomi%3A%2F%2Fprovider%2Fcallback
     &state={state}&code_challenge={S256(code_verifier)}&code_challenge_method=S256
   ```

4. 用户在第三方供应商的页面上登录、同意后，页面跳到
   `nomi://provider/callback?code={code}&state={state}`（拒绝时 `error=access_denied&state=…`）。
5. Nomi 按 `state` 找回这次授权（10 分钟内有效、只能用一次），向 `token_endpoint` 发
   `POST application/x-www-form-urlencoded`：

   ```
   grant_type=authorization_code&code=…&redirect_uri=nomi://provider/callback&client_id=nomi&code_verifier=…
   ```

   返回 `{ "api_key": "sk-…", "name"?: "…", "urls"?: {…}, "models"?: […] }`（`key` / `access_token` 也认）。
   返回里的 `urls` 覆盖清单里的同名协议。

6. 弹出与 A 相同的确认框，确认后保存。

## Nomi 的处理规则

- **一律先确认**：确认框显示名称、来源（A：「链接」，无法验证来源网站；B：issuer 域名）、各协议地址、
  打码后的 Key、模型数量；B 的第一步（打开浏览器去授权）也要确认。
- **地址**：只接受 `https`、不带用户名密码、不指向本机 / 局域网的地址（要接本机服务请在设置里手动添加）。
- **授权网站的解析**：与网关连上游同一套规则：解析到本机 / 局域网的拒绝（错误码 `private_host`），
  代理软件的 fake-ip（198.18.0.0/15）对域名放行；解析失败报 `network`。
- **来源只写能核实的**：方式 A 只说「网页链接，无法确认来自哪个网站」，不显示链接自带的网站名 / 主页；
  方式 B 写 issuer 域名（Nomi 自己连过它）。
- **添加后补模型**：链接没带模型时，保存后用刚存的 Key 检测一次，按添加时的规则启用对话模型。
- **已存在就更新**：已有第三方供应商的某个地址与链接里的相同（忽略末尾 `/`），就更新那一个：
  补上新 Key（已有同样的 Key 不重复加），补上没填过的协议地址和模型；否则新建。
- **限额**：整条链接 ≤ 16 KB；名称 ≤ 64 字；Key 8–512 个可见字符；模型最多 200 个；
  同时等待确认的最多 5 条，10 分钟过期，同样的内容只留一条。
- **不留痕**：链接里有 Key，日志里只记链接类型，不记原文；Key 只在内核里，视图只拿到打码后的样子。
- **冷启动**：应用没开时被链接拉起，内核先把它存着，对话窗口挂载后拉取（`providerLink.list`），
  已开着的窗口经 `providerLink.changed` 收到。

## 实现位置

- 解析 / 校验 / PKCE：`apps/desktop-electron/internal/core/src/gateway/providerLink.ts`，
  Go：`apps/desktop-go/internal/core/providerlink`；两边用同一份用例
  （`apps/desktop-electron/internal/core/tests/fixtures/provider-link-cases.json`）。
- 状态与流程：`ProviderLinkService`（内核），宿主只把收到的 `nomi://` 链接交给它。
- 契约：`providerLink.list / accept / reject / connect`，事件 `providerLink.changed`（`packages/contract/src/app/shell.ts`）。
- 视图：`packages/ai-chat/src/components/ProviderLink`。
