# @nomi-ai/gateway

统一网关内核：Anthropic Messages、OpenAI Responses、OpenAI Chat Completions、Gemini generateContent 四种协议之间的请求与响应互转。纯 Node 实现，不依赖 Electron。设计见 [docs/design/unified-gateway.md](../../../../docs/design/unified-gateway.md)。

## 结构

| 路径                    | 内容                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `src/ir.ts`             | 统一中间表示（IR）类型                                                   |
| `src/request/decode.ts` | 4 个入口请求解码器（请求 → IR）                                          |
| `src/request/encode.ts` | 4 个上游请求编码器（IR → 请求）                                          |
| `src/stream/`           | 流式：4 个上游 SSE 解码器、4 个入口 SSE 编码器、非流式 JSON 的读取与聚合 |
| `src/ingress.ts`        | 按请求路径识别入口协议；Gemini 上游路径里的模型段                        |
| `src/transforms.ts`     | 两两转换的旧接口（本地路由服务在用），请求方向内部走 IR                  |

## 约定

- **同协议不经过 IR**：IR 会丢掉协议的新字段，同协议只做外科式改写（替换模型名等）。
- 推理相关的流式事件（`think`、`think_sig`、`sealed`、`text_sig`）由解码器产出；Messages / Responses / Chat 编码器暂不输出它们，Gemini 编码器输出推理文本。
- 改动转换逻辑后，`tests/parity.test.ts` 的快照如有变化，要确认是有意的再更新（`vitest -u`）。

```bash
pnpm --filter @nomi-ai/gateway build
pnpm --filter @nomi-ai/gateway test
```
