---
'@nomi-ai/desktop-go': patch
---

fix(chat): 后台的 Nomi 和知识库问答改为用你提问的语言回复，不再固定用中文。生图服务暂时出错（网络、超时、限流、服务端错误）时自动重试两次，图已生成只是下载失败时只重新下载。/ Background Nomi and knowledge-base answers now reply in the language you asked in instead of always Chinese. Image generation retries twice on temporary errors (network, timeout, rate limit, server error), and only re-downloads when the image was made but the download failed.
