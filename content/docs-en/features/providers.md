# Third-Party Providers and Models

Entry point: **Settings → Models & Agents → Third-Party Providers** (with **Task & Cost Routing** in the first tab). Both Nomi chat and agents using third-party models connect through the local unified gateway, which handles protocol translation automatically. **Circuit breaker & failover** at the top right is off by default; enable it if you want automatic failover across providers.

## Switching Models

The **model picker** in the chat area (grouped by provider, showing reasoning / vision / context length), the tray **Chat model** menu, and `/model` all update the same assignment and take effect on the next request.

## Adding a Third-Party Provider

No protocol selection is needed:

1. **Choose a source**: Search presets (model vendors, relay platforms, and local services such as DeepSeek, Kimi, Zhipu GLM, Qwen, MiniMax, OpenRouter, OpenCode Go, Ollama, LM Studio) or choose **Custom URL**.
2. **Enter credentials**: You can paste multiple keys at once (one per line; the first is the primary key and the rest act as fallbacks in order). For a custom URL, you can paste the base URL, `/v1`, or the full `/v1/chat/completions` path. If the service does not expose a model list, enter a model ID for testing.
3. **Probe and save**: Nomi probes four protocols in parallel—Anthropic Messages, OpenAI Responses, Chat Completions, and Gemini—showing the result and failure reason for each. At least one protocol must succeed before saving. Fetched models have preset-recommended ones enabled by default; non-chat models (embeddings, audio, etc.) are listed but disabled.

Local or LAN addresses (Ollama, self-hosted services) require confirmation before Nomi connects: local service presets are auto-confirmed, while custom URLs prompt for confirmation.

## Adding from the Web

Third-party providers that support Nomi links can be added directly from their website:

- **One-click import**: Click "Add to Nomi" (`nomi://provider/import` link) on the provider's website. Nomi opens a confirmation dialog displaying the name, per-protocol URLs, masked key, and model count; it only saves after you click **Add**.
- **Web authorization**: Click "Connect Nomi" (`nomi://provider/connect`) on the provider's website, or click **Web authorization** on the **Third-party providers** page and enter its URL. After confirmation, your browser opens its authorization page; once you sign in and approve, return to Nomi to confirm once more. Nomi exchanges the key directly with the third-party provider so the key never appears in the link.

Links may only carry public `https` URLs. If a third-party provider with the same URL already exists, confirming updates it rather than creating a duplicate. Up to 5 pending links can wait for confirmation, expiring after 10 minutes. Only add third-party providers you trust, as requests routed through them carry your conversation content. See [Provider Link Integration](../integrations/provider-link.md) for integration details.

## Assignments

Configure which model is used where under **Assignments**:

- **Nomi**: Chat, tool calling, summarization (the latter two default to **Follow chat**), and image generation (defaults to **Auto**, picking an image model from the same vendor as the chat model).
- **Agents**: The default model each CLI uses when set to **Third-party**, plus the helper model (for generating titles, writing summaries, etc.; matches the main model if unset). For Claude Code, you can also expand **Tier models** to set Opus / Sonnet / Haiku / Fable tiers and the subagent model (Haiku tier is used for background tasks).

## Multi-Key, Reconnect, and Fallback

Each provider can have one primary key and multiple fallback keys; the UI displays masked values only.

- On transient upstream errors (`408`, `429`, `5xx`, timeouts, connection failures), Nomi retries with backoff on the same key first (starting at 0.5s, up to 8s, or honoring the upstream `Retry-After` duration)—up to 3 attempts per key, or 5 attempts when there is only one key—before moving to the next key. Invalid keys (`401` / `403`) switch to the next key immediately.
- After 10 cumulative failures on one provider, Nomi falls back to the next provider that offers **the same model**. It never silently substitutes a different model; if no other provider offers that model, an error is returned. When a local or LAN provider fails, it only falls back to other local or LAN providers and never sends requests to the cloud.
- Once a response has started streaming output, retries stop to avoid stitching a single reply from two separate requests.
- You can drag to reorder the provider list (keyboard: `Alt+↑/↓` on the drag handle); providers higher in the list have priority. Each row has a toggle to disable or enable it directly.

## Editing a Provider

Click a row to open its details:

- **Keys**: Reorder (which sets fallback order), disable, rename, delete, or append keys. Each key shows its latest error, which clears automatically once it recovers.
- **Models**: Check to enable, add a model ID manually, or click **Refresh** to re-fetch (new models default to disabled). You can search and filter; **Enable all / Disable all** applies only to the currently filtered models.
- **Advanced**: Per-protocol URLs (leave blank to disable), restricting a model or key to a specific protocol, model mapping, custom headers and `User-Agent`, and clearing auto-learned state. Each key supports a concurrency limit and requests-per-minute limit (excess requests queue), plus a private note (account name, balance, expiration, up to 200 characters—visible only to you and never sent to the provider), shown truncated next to the masked key. Request body limit defaults to 32 MiB and can be adjusted from 1 to 256 MiB.
- **Known model to treat as**: Assigning a known model (`like`) to a model lets Nomi derive its capabilities and usage pricing from that known model. When a model mapping is configured (public name → upstream name), usage logs record the actual name sent upstream while pricing uses the `like` set on the public name. If multiple public names map to the same upstream name with conflicting `like` settings, Nomi does not guess and marks usage as unpriced.

## Automatic Parameter Adaptation

Based on the built-in model catalog (from `models.dev`) and model-family rules, the gateway adapts requests into what the upstream model accepts: clamping out-of-range reasoning effort to the nearest supported level, handling unsupported sampling parameters, `max_tokens` formatting, and reasoning-content passback per model, and replacing images with a one-line note for models without vision support. When an upstream explicitly rejects a parameter, the gateway retries once with an alternate form and remembers the result. Every adjustment is noted under **Usage & analytics → Requests**.

**Strict mode** (toggle next to **Show APIs** on the **Third-party providers** page, off by default): When enabled, unsupported parameters fail immediately instead of being adapted, which is useful for diagnosing why a parameter did not take effect.

## Agents Using Third-Party Models

- Each agent tab chooses **Official account** or **Third-party** in the top-right of the chat area. This applies only to that tab; see [Agents](coding-agents.md#official-accounts-and-third-party-providers).
- Third-party configuration applies only to the CLI process launched by Nomi—it never modifies any CLI's global config or touches official credentials. Session history is still written to each CLI's own directory as usual.
- When starting a third-party session, Nomi passes the model's actual context window and output limit to the CLI to avoid premature compaction or overflow errors.
- When switching a third-party tab back to an official account, third-party reasoning content cannot be sent to official endpoints, so Nomi continues in a new session with context carried over while keeping the original session intact.
- Each third-party tab's CLI process accesses the gateway with its own one-time token (passed only in that process's environment; the gateway stores only the hash), which is invalidated immediately when the process exits or the tab closes. Official tabs never carry a token.
  MiniMax Code's custom provider only reads keys written to its config file, so its token is written to a tab-private config file (readable only by you, permissions `600`) that is also invalidated when the tab closes.

## Terminal Launch Commands

Toggle at the bottom of the **Third-party providers** page (off by default). When enabled, Nomi generates `nomi-claude`, `nomi-codex`, `nomi-gemini`, `nomi-grok`, and `nomi-dsh` in `~/.nomi/bin/`: running them in a terminal uses the third-party model assigned to that CLI under **Assignments**, and `--nomi-model provider/model` overrides the model for that run. Running `claude` or `codex` directly still uses your official login. Nomi must be running. Terminal launch commands are not yet available for Kimi Code or MiniMax Code. Nomi asks for confirmation before updating `PATH`, adding only a marked block to your shell config (or updating user `PATH` on Windows) and removing it when you turn the toggle off.

## Usage and Model Quality

In **Settings → Usage & analytics**:

- **Usage & cost**: Token usage and cost parsed from local coding tools (Claude Code, Codex, dsh, Grok, Gemini CLI, Qwen Code, OpenCode, GitHub Copilot CLI, Kimi, Aider), alongside official account subscription quotas. Budget, privacy, pricing, and model-data sync settings live here too. See [Privacy & Security](privacy-security.md#coding-tool-usage-logs) for how logs are read.
- **Comparison / Trends / Requests**: Continuously records per-request success rate, time to first token, duration, output speed, and cache hit rate for comparison by model, provider, key, and client. Reported across two scopes: **Gateway layer** (HTTP requests through the Nomi gateway) and **CLI layer** (each turn of an agent running in Nomi, including CLI and tool overhead). Only metadata is stored—no chat content—and retained for 30 days by default (configurable to 7 / 30 / 90 days).

## Security

- API keys are encrypted using the OS secure storage (macOS Keychain / Windows DPAPI / Linux Secret Service) and stored locally; the UI only receives masked values. Keys are sent only with requests to the URL you configured for that provider.
- The gateway listens on localhost only, with each client authenticating via its own token; outbound requests pin the resolved IP to prevent DNS rebinding.
- Tool-result destinations are evaluated against the actual upstream: cloud providers accessed through the gateway are treated as cloud services, so **Only local models can read files** and cloud consent prompts apply as usual.
- Before sending to a third-party provider, secrets in chats, file contents, and command output are replaced with placeholders by default; see [Privacy & Security](privacy-security.md#outbound-protection).

## Environment Variables

- Providers supplied via `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `OLLAMA_BASE_URL` are loaded read-only and used by default when no model is assigned for Nomi chat.
- `NOMI_PROVIDER=<id>` forces Nomi chat to use a specific provider (locking the model picker and tray menu).

## Implementation

- Gateway: [Unified Gateway](../development/gateway.md), implemented in `apps/desktop-go/internal/gateway` (retry and fallback in `server/retry.go`).
- Provider storage: `apps/desktop-go/internal/core/gwstore` (`userData/gateway/`); web links: `internal/core/providerlink`; terminal launch commands: `internal/core/terminal`; usage: `internal/core/usage`.
- UI: `packages/ai-chat/src/components/ModelsPage`, `ProviderLink`, `UsagePanel`, and `QualityPanel`.
