# Unified Gateway

Configure a third-party provider once, and both Nomi chat and all agents (Claude Code, Codex, Gemini CLI, Grok, dsh) can use it. The gateway is a local HTTP service inside the Go core (`apps/desktop-go/internal/gateway`), listening exclusively on the loopback address at default port 18721 (`DefaultGatewayPort` in `internal/core/gwstore`). It accepts requests in each client's native protocol, decodes them into an intermediate representation (IR), dispatches them to upstream providers according to a route plan, and translates the response stream back into the client's protocol.

```
CLI / Nomi Chat ──(Messages | Responses | Chat | Gemini)──▶ Ingress Detection → Decode to IR → Route Plan → Upstream Request
                                                                                                         │
Client ◀── Client Adapter ◀── Protocol Bridge (passthrough / translate) ◀── Canonicalizer ◀── Upstream SSE Decode ◀──┘
```

## Ingress and Authentication

| Path | Protocol |
| --- | --- |
| `.../messages`, `.../messages/count_tokens` | Anthropic Messages |
| `.../responses` | OpenAI Responses |
| `.../chat/completions` | OpenAI Chat Completions |
| `/v1beta/models/<model>:generateContent` / `:streamGenerateContent` / `:countTokens` | Gemini |
| `GET .../models` | Model list (formatted per client protocol) |
| `GET /health`, `GET /metrics` | Health check, route quality snapshot (loopback-only, `Host`-validated, no token required) |

- Validates the `Host` header (DNS rebinding protection); invalid hosts receive HTTP 421.
- Before launching a CLI for any third-party tab, the core issues a `nomi-tab-` token and registers a binding with the gateway (tab, generation, model, thinking depth). The CLI uses this token as its API key. The gateway resolves the model from the binding, tags request logs with the tab ID, and revokes the binding when the process exits or the tab closes (`internal/gateway/route/binding.go`). Missing or invalid tokens return an authentication error formatted for that protocol.
- All errors are encoded in the ingress protocol's error format (`internal/gateway/errors`) so clients display them properly.

## Layers

| Directory | Role |
| --- | --- |
| `upstream/` | Ingress detection (`IngressFromPath`), upstream request fixups and retries |
| `request/`, `ir/` | Bidirectional conversion between each protocol's request and the protocol-agnostic IR |
| `providers/` | Provider adapters: built-in presets and domain-matched specs (auth headers, endpoints, protocol capabilities) |
| `models/` | Model catalog (`catalog.json`, bundled offline), model family rules, request rules, effective model merging, model listing |
| `route/` | Route planning: candidates (provider x key x protocol), binding resolution, native-protocol preference, failover, and fixers |
| `stream/` | Upstream SSE decoding and event layer |
| `canonical/`, `spec/` | Field completion and completion detection according to each protocol's specification tables |
| `clients/` | Client adapters: emit response streams matching each CLI's accepted format |
| `server/` | HTTP server, protocol bridge (`bridge.go`, passthrough or translate), first content-event commit (`commit.go`), session affinity, retries, tracing, usage accounting, metrics |
| `privacy/` | Privacy mode: replaces secrets and other sensitive strings with placeholders before sending upstream, then restores them in responses |
| `net/` | Address classification and outbound guard (blocks localhost/private IP addresses and pins DNS resolutions) |
| `probe/` | Protocol probing when adding a provider |
| `media/` | Image generation adapters and endpoints |

When fixing gateway or stream parsing issues, cover all four protocols and both passthrough and translation paths: first fix the issue in the shared layers (`stream/` event layer, `canonical/`), and only patch individual protocols when a shared fix is not possible, adding tests for each.

## Providers and Models

- Third-party providers and API keys are stored solely in the gateway store `userData/gateway/store.json` (`internal/core/gwstore`, keys encrypted); Nomi chat, `agent-tools`, and `summary` all resolve models via the gateway.
- Model capabilities (context/output limits, input modalities, tool calling, reasoning levels, sampling parameters) come from `models/catalog.json`, merged with provider-returned model lists and user overrides into effective models.
- The route plan selects an upstream protocol for each request: it passes through directly when the provider natively supports the ingress protocol, and translates otherwise. Multiple keys or protocols under the same provider are ranked by health samples with automatic failover.

## Observability and Troubleshooting

- When diagnostics are enabled, the gateway writes per-request trace files (`userData/gateway/trace/*.json`: ingress request, raw upstream response, diff of output sent to the client), and responses carry the `x-nomi-trace-id` header.
- `GET /metrics`: live snapshot of route quality and loss metrics.
- Usage is tallied from the stream per ingress protocol (`server/usagetap.go`) and written to the usage ledger.

## Testing

`apps/desktop-go/internal/gateway/**/_test.go`: per-layer unit tests, concurrency and race tests (`concurrency_test.go`), and long-context end-to-end tests (`context1m_e2e_test.go`). Use `internal/mockllm` for a mock upstream.
