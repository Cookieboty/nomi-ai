# Third-Party Provider Deep Links (`nomi://provider/*`)

Third-party providers (API relays and model platforms) can put a button on their website so users can add the provider to Nomi's gateway with one click.
Both integration methods stop at a confirmation dialog inside Nomi: **nothing is written until the user clicks Confirm**.

| Method             | Link                                   | Best for                                                                               | Key in link?                        |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| A Direct import    | `nomi://provider/import?v=1&data=…`    | Relay "one-click fill" buttons; takes only a few lines of template code                | Yes                                 |
| B Authorized link  | `nomi://provider/connect?v=1&issuer=…` | Platforms with user accounts willing to add an auth page and a key-exchange endpoint   | No (exchanged via PKCE auth code)   |

Industry references: Cherry Studio's `cherrystudio://providers/api-keys?v=1&data=<base64>` (Method A is compatible with its fields),
CC Switch's `ccswitch://v1/import`, base64-payload MCP install links in Cursor / VS Code, and OpenRouter's PKCE flow (Method B).

## A: Direct import

```
nomi://provider/import?v=1&data=<base64url(UTF-8 JSON)>
```

`data` uses base64url (`+/` replaced with `-_`, `=` padding optional); standard base64 is also accepted. JSON:

```jsonc
{
  "name": "Example AI", // Required, 1–64 characters
  "homepage": "https://example.com", // Optional: shown in confirmation dialog
  "urls": {
    // At least one required; maps to Nomi gateway's four protocols
    "chat": "https://api.example.com/v1", // OpenAI Chat Completions
    "responses": "https://api.example.com/v1", // OpenAI Responses
    "messages": "https://api.example.com", // Anthropic Messages
    "gemini": "https://api.example.com/gemini", // Gemini
  },
  "key": "sk-…", // Required
  "models": ["claude-sonnet-5-5", "gpt-5"], // Optional: pre-populated models
}
```

Also compatible with Cherry Studio's flat format: `{ "name", "baseUrl", "apiKey", "type"? }`. When `type` is `anthropic`,
`baseUrl` maps to `messages`; `gemini` maps to `gemini`; everything else maps to `chat`.

Relay template example (for the "Chat link" field in New API, etc.):

```
nomi://provider/import?v=1&data={base64 of {"name":"Example AI","baseUrl":"{address}/v1","apiKey":"{key}"}}
```

## B: Authorized connect

1. Place the link `nomi://provider/connect?v=1&issuer=https://example.com` on your page (`issuer` must be an `https` origin with no path).
   Users can also initiate this by entering the domain in Nomi's "Add third-party provider" dialog.
2. Nomi fetches `https://example.com/.well-known/nomi-provider.json`:

   ```jsonc
   {
     "version": 1,
     "name": "Example AI",
     "homepage": "https://example.com",
     "urls": { "chat": "https://api.example.com/v1", "messages": "https://api.example.com" },
     "models": ["…"], // Optional
     "authorization_endpoint": "https://example.com/nomi/authorize",
     "token_endpoint": "https://example.com/api/nomi/token",
   }
   ```

   Both endpoints must use `https`, and their hosts must match the `issuer` host or one of its subdomains.

3. After the user confirms inside Nomi, Nomi opens the system browser to:

   ```
   {authorization_endpoint}?response_type=code&client_id=nomi
     &redirect_uri=nomi%3A%2F%2Fprovider%2Fcallback
     &state={state}&code_challenge={S256(code_verifier)}&code_challenge_method=S256
   ```

4. After the user signs in and approves on the third-party provider's page, the page redirects to
   `nomi://provider/callback?code={code}&state={state}` (or `error=access_denied&state=…` on rejection).
5. Nomi matches `state` to the pending session (valid for 10 minutes, single-use) and sends a
   `POST application/x-www-form-urlencoded` request to `token_endpoint`:

   ```
   grant_type=authorization_code&code=…&redirect_uri=nomi://provider/callback&client_id=nomi&code_verifier=…
   ```

   The endpoint returns `{ "api_key": "sk-…", "name"?: "…", "urls"?: {…}, "models"?: […] }` (`key` / `access_token` are also accepted).
   Any `urls` in the token response override matching protocol entries from the manifest.

6. Nomi opens the same confirmation dialog as Method A and saves the provider once confirmed.

## Nomi's handling rules

- **Always confirm first**: The confirmation dialog shows the name, source (A: "Link", source website cannot be verified; B: issuer domain), protocol URLs, masked key, and model count; step 1 of Method B (opening the browser to authorize) also requires confirmation.
- **URLs**: Only `https` URLs without embedded credentials and not pointing to localhost or a LAN address are accepted (add local services manually in Settings).
- **Resolving the authorization host**: Follows the same rules as the gateway connecting upstream—hosts resolving to localhost / LAN are rejected (error code `private_host`), proxy fake-IPs (`198.18.0.0/15`) are allowed for domain names, and resolution failures report `network`.
- **Show only verifiable sources**: Method A states only "Web link; unable to verify which website it came from" and does not display the link's self-reported site name or homepage; Method B displays the issuer domain (which Nomi connected to directly).
- **Populate models after adding**: When a link omits models, Nomi runs a probe with the newly saved key after saving and enables chat models according to the standard add-provider rules.
- **Update if existing**: If an existing third-party provider already has one of the link's URLs (ignoring trailing `/`), Nomi updates that entry—adding the new key (skipping duplicates) and filling in any unset protocol URLs and models; otherwise it creates a new provider. All URLs in the link must share the same origin (scheme + host + port) as that provider's existing URLs: if another domain is included, Nomi creates a new provider containing only the link's new key so existing keys are never sent to the newly added domain (#249).
- **Limits**: Total link length ≤ 16 KB; name ≤ 64 characters; key 8–512 printable characters; up to 200 models; at most 5 pending confirmations at once, expiring after 10 minutes, with identical payloads deduplicated.
- **No key leaks in logs**: Because links may contain keys, logs record only the link type and never the raw link; keys stay in the core, and views only receive masked values.
- **Cold start**: If the app is launched via a link while closed, the core holds it until the chat window mounts and fetches it (`providerLink.list`); already-open windows receive it via `providerLink.changed`.

## Implementation locations

- Parsing, validation, PKCE: `apps/desktop-go/internal/core/providerlink/link.go`; flow and state (pending links, auth sessions, fetching manifests, exchanging keys): `service.go` in the same directory. The host only passes incoming `nomi://` links to it (storing them on cold start).
- Contract: `providerLink.list / accept / reject / connect`, event `providerLink.changed` (`packages/contract/src/app/shell.ts`), handlers in `apps/desktop-go/internal/core/shellhandlers/providerlink.go`.
- UI: `packages/ai-chat/src/components/ProviderLink`.
