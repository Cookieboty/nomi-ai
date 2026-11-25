# App Contract

All calls and pushed events between the views (`packages/ai-chat`, `packages/renderer`) and the core go through the app contract. The contract is defined once in `packages/contract` (using Zod schemas), from which the Go core's procedure table, types, and unimplemented stubs are generated.

```
packages/contract/src/app/<domain>.ts  ──pnpm --filter @nomi-ai/contract build──▶ dist
                                       ──node scripts/go-contract/gen.mjs──────▶ apps/desktop-go/internal/contract/gen/
View: api.<domain>.<procedure>(...) in services/api.ts  ⇄  Loopback WebSocket  ⇄  Go: internal/contract.Router → internal/core/<domain>handlers
```

## What Is in the Contract

| Item | Location | Description |
| --- | --- | --- |
| Procedures | `packages/contract/src/app/{ai,shell,coding,knowledge,media,mascot}.ts` | Dot-separated names (`appIcon.set`); `query` / `mutation` / `stream` (`stream` also defines a per-chunk schema) |
| Events | Same as above, `events` | Pushed from the core to views; delivered only after a view subscribes via `api.on(name, fn)` |
| Business error codes | Each domain's `errors` | E.g., `KB_EMPTY`, `SCHED_NOT_FOUND`; generated into Go's `gen.Errors` |
| Version | `appContract.version` | Handshaken via `meta.version` before the client's first call; a major mismatch fails calls with `VERSION_MISMATCH`; Go returns `ContractVersion` from `internal/contract/frames.go` |

Procedure access control is declared directly on the definition and enforced by guards on both sides (Go: `guard` in `internal/contract/frames.go`):

- `surfaces`: Allowed calling surfaces (`chat` / `mascot` / `settings`); omitted means all surfaces; mismatches return `FORBIDDEN`.
- `dangerous: true`: Accepts only trusted callers (procedures that modify files, execute commands, or touch secrets).
- The caller's surface is determined by the host: each window gets a one-time token, the core maps `token -> surface`, and if the surface claimed in the subprotocol does not match, the handshake is rejected (`internal/contract/websocket.go`). Views cannot choose their own identity.

## Transport

- When creating a window, the Go host passes `ws://127.0.0.1:<port>` and that window's token in the URL fragment (`#ws=...&token=...`; fragments are never sent to the server).
- Before building the client, each view's `services/api.ts` calls `installGoHostTransport(surface)` (`@nomi-ai/ai-sdk-client`), which installs the WebSocket transport (`createWebSocketClientTransport`, accepting only `127.0.0.1`) when configuration is present. A window has only one contract session, shared between `api` and `ClientAIClient` in `AIProvider`.
- Outside a Nomi window (tests, browser preview), no transport is installed: `hasTransport()` is false, and calls fail with `BRIDGE_MISSING`.
- Wire protocol: the client sends `req` / `abort` / `sub` / `unsub`, and the server replies with `res` / `chunk` / `end` / `err` / `event` (`packages/contract/src/protocol.ts`). Only JSON values and `Uint8Array` (base64-encoded over WebSocket per `wire.ts`) are supported; `Date` / `Map` / `Set` cannot cross the wire.
- When a window closes, the host revokes its token and closes the connection. After a disconnect, the client reconnects with backoff and restores event subscriptions.
- Validation: by default, the client validates inputs, results, every chunk, and every event against schemas. Production builds of the views (`import.meta.env.PROD`) enable lean validation in `services/api.ts` (`setLeanValidation({ events: APP_HIGH_FREQUENCY_EVENTS, procedures: APP_LARGE_RESULT_PROCEDURES })`): streaming chunks, high-frequency events (streaming output, cursor, window movement, full messages pushed at turn end), chunk/event frame envelopes, and results of large-result procedures (full conversation messages, full git diffs, workspace file trees) skip validation; inputs, other call results, final stream results, and other events are still validated as usual. Schemas for these skipped events and procedures must not use `default` or `transform` (since raw values are returned when validation is bypassed).

## Adding a Procedure

1. Add the definition in the corresponding domain file `packages/contract/src/app/<domain>.ts` (input/output schemas, `surfaces`, `dangerous`).
2. Generate the Go side:

   ```bash
   pnpm --filter @nomi-ai/contract build
   node scripts/go-contract/gen.mjs          # --check only checks (CI runs on Linux)
   ```

   Do not manually edit the generated files `internal/contract/gen/{procedures_gen,types_gen}.go` or `contract.schema.json`.

3. Implement in Go: place handlers by domain under `internal/core/<domain>handlers` (`shellhandlers`, `codinghandlers`, `knowledgehandlers`, `mediahandlers`, `mascothandlers`), register with `r.Call(name, ...)` / `r.Stream(name, ...)`, and wire them in the composition root (`main.go` / `*_wiring.go`). Unregistered procedures are backed by stubs in `internal/procs` that return `UNAVAILABLE`, so views always receive an explicit error.
4. Call from the view via `api.<domain>.<procedure>(...)`. Only `services/api.ts` may create clients or select transports (ESLint blocks other locations); shared packages (`@nomi-ai/ui`, `@nomi-ai/voice`) receive host capabilities through `services/hostBackends/<domain>.ts`.
5. Push events: on the Go side, use `r.Emit(event, data)` (all subscribed windows) or `r.EmitTo(event, data, surface)` (a specific surface); event names must first be declared in the contract.

## Testing

- `packages/contract/tests`: schemas, procedure table snapshots, WebSocket transport, wire protocol.
- In views, use the in-process transport from `@nomi-ai/contract/testing` or the fake core in `packages/ai-chat/tests/helpers/fakeApi.ts`.
- In Go, `internal/contract/*_test.go` tests routing, guards, and WebSocket handshakes; each handlers package tests its own procedures.
