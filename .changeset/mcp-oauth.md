---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

feat(mcp): 远程（HTTP / SSE）MCP 服务支持浏览器 OAuth 授权：自动发现、PKCE、可填客户端 ID，凭据加密保存并自动续期，可取消、清除或重新授权；手填了 Authorization 请求头的服务照旧。修改服务的地址、请求头等连接配置会清除旧授权并按新配置重连；禁用、删除或修改时会取消旧连接与未完成的授权。/ Remote (HTTP / SSE) MCP servers can be authorized in the browser via OAuth (discovery, PKCE, optional client ID); credentials are stored encrypted and refreshed automatically, and authorization can be cancelled, cleared or redone. Servers with a manual Authorization header are unchanged. Changing a server's URL, headers or other connection settings clears its old authorization and reconnects with the new settings; disabling, deleting or editing a server cancels its old connection and any pending authorization.
