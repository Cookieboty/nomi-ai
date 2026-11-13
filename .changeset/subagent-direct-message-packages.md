---
'@nomi-ai/contract': minor
'@nomi-ai/i18n': patch
---

feat(contract): 新增 `harness.messageAgent`（在子任务侧栏里直接对 CLI 子代理说话，结果带 `via` / `reason` / 关联标签 `tabId`）；`tasks.followUp` 接受 `images`（最多 8 张，可以只带图片）；补上直接对子代理说话的中英文案，删掉「后台 Nomi 追问只能发文字」。/ Add `harness.messageAgent` (message a CLI subagent directly from the side panel; the result carries `via` / `reason` / the linked `tabId`); `tasks.followUp` accepts `images` (up to 8, images alone are fine); zh / en copy for direct subagent messages, and drop the "text-only follow-ups" notice.
