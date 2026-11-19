---
'@nomi-ai/i18n': patch
---

fix(harness): 空会话的来源与模型自动纠偏，发送前先做配置预检。还没说过话的 Agent 标签会在账号登录、供应商配置或模型目录变化后自己回到可用的来源（官方账号 → 本机登录 → 第三方模型，反向也可），已失效的第三方模型选择会被清掉并顺手换成新的默认；多供应商又没有默认模型时进入显式待选态，不再盲选第一家，也不再为它预热进程。真正发消息前统一预检一次，缺账号 / 缺本机登录 / 没选模型会直接给出可读原因（新增两条文案）而不是把请求发出去撞墙。切标签时顺手清掉上一条从未使用过的瞬态空标签（连同进程与临时文件），标签快照里也不再出现它。/ Empty Agent tabs now reconcile their own source and model after sign-in, provider or catalog changes (official → local sign-in → third-party and back), drop third-party picks that no longer exist, and wait for an explicit model choice instead of silently taking the first provider when several are configured without a default — those tabs are no longer prewarmed. Sending runs a preflight first and reports a readable reason (two new messages) when an account, local login or model is missing, and switching tabs silently discards the previous never-used empty tab along with its process and temp files.
