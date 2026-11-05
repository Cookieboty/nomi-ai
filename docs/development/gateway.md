# 统一网关

一个第三方供应商配一次，Nomi 对话和所有编程助手（Claude Code、Codex、Gemini CLI、Grok、dsh）都能用。网关是 Go 内核里的
本机 HTTP 服务（`apps/desktop-go/internal/gateway`），只监听回环地址，默认端口 18721（`internal/core/gwstore`
`DefaultGatewayPort`）。它接收各家客户端协议的请求，转成中间表示，按路由计划发给上游供应商，再把响应流转回客户端的协议。

```
CLI / Nomi 对话 ──(Messages | Responses | Chat | Gemini)──▶ 入口识别 → 解码成 IR → 路由计划 → 上游请求
                                                                                      │
客户端 ◀── 客户端适配 ◀── 协议桥（透传 / 转换）◀── 规范化 ◀── 上游 SSE 解码 ◀──────────┘
```

## 入口与鉴权

| 路径                                                                                | 协议                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `…/messages`、`…/messages/count_tokens`                                             | Anthropic Messages                                    |
| `…/responses`                                                                       | OpenAI Responses                                      |
| `…/chat/completions`                                                                | OpenAI Chat Completions                               |
| `/v1beta/models/<模型>:generateContent` / `:streamGenerateContent` / `:countTokens` | Gemini                                                |
| `GET …/models`                                                                      | 模型列表（按客户端协议格式返回）                      |
| `GET /health`、`GET /metrics`                                                       | 健康检查、路由质量快照（只回环、校验 Host，无需令牌） |

- 校验 `Host` 头（防 DNS 重绑定），不对返回 421。
- 每个第三方标签启动 CLI 前，内核签一个 `nomi-tab-` 令牌并向网关登记绑定（标签、代次、模型、思考深度），CLI 用它当 API Key；
  网关按绑定解析模型，请求日志带标签 id，进程退出或标签关闭时作废（`internal/gateway/route/binding.go`）。缺少或错误的令牌返回协议对应的鉴权错误。
- 所有错误都按入口协议的错误格式编码（`internal/gateway/errors`），客户端能正常显示。

## 分层

| 目录                  | 作用                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `upstream/`           | 入口识别（`IngressFromPath`）、对上游的请求修正与重试                                                               |
| `request/`、`ir/`     | 各协议请求 ⇄ 协议无关的中间表示                                                                                     |
| `providers/`          | 供应商适配：内置预设与按域名匹配的规格（鉴权头、地址、协议能力）                                                    |
| `models/`             | 模型目录（`catalog.json`，离线随包）、模型族规则、请求规则、有效模型合并、模型列表                                  |
| `route/`              | 路由计划：候选（供应商 × Key × 协议）、绑定解析、原生协议优先、失败切换与修正器                                     |
| `stream/`             | 上游 SSE 解码与事件层                                                                                               |
| `canonical/`、`spec/` | 按各协议规范表补齐字段、检测结束                                                                                    |
| `clients/`            | 客户端适配：按 CLI 的规格输出它能接受的流                                                                           |
| `server/`             | HTTP 服务、协议桥（`bridge.go`，透传或转换）、首个内容事件提交（`commit.go`）、会话亲和、重试、追踪、用量统计、指标 |
| `privacy/`            | 隐私模式：发给上游前把密钥等敏感串换成占位符，回来的内容再换回去                                                    |
| `net/`                | 地址分类与出站守卫（拦本机 / 内网地址、DNS 钉 IP）                                                                  |
| `probe/`              | 添加供应商时的协议探测                                                                                              |
| `media/`              | 生图的适配器与端点                                                                                                  |

修网关或流式解析问题要覆盖全部四种协议，直通与转换两条路径都要考虑：先找各协议共用的层（`stream/` 事件层、`canonical/`）统一修，
做不到再逐个协议补，并各自加测试。

## 供应商与模型

- 第三方供应商与 Key 只存在网关存储 `userData/gateway/store.json`（`internal/core/gwstore`，Key 加密存储）；Nomi 对话、
  agent-tools、摘要都经网关解析模型。
- 模型能力（上下文 / 输出上限、输入模态、工具调用、推理档位、采样参数）来自 `models/catalog.json`，供应商返回的模型列表与用户覆盖合并成有效模型。
- 路由计划为每次请求选上游协议：供应商原生支持入口协议时直通，否则转换；同一供应商多个 Key / 协议按健康样本排序，失败时切换。

## 观测与排查

- 诊断开关打开时，网关按请求写追踪文件（`userData/gateway/trace/*.json`：入口请求、上游原始响应、给客户端的输出差异），
  响应头带 `x-nomi-trace-id`。
- `GET /metrics`：路由质量与损失的实时快照。
- 用量按入口协议从流里统计（`server/usagetap.go`），写进用量账本。

## 测试

`apps/desktop-go/internal/gateway/**/_test.go`：各层单测、并发与竞态（`concurrency_test.go`）、长上下文端到端（`context1m_e2e_test.go`）。
假上游可用 `internal/mockllm`。
