---
'@nomi-ai/desktop-go': patch
---

fix(cli): 定时 / 持续任务的执行档位在就绪检查、执行与标签复用时统一按当前档位解析 agent、来源、账号、模型与思考深度；档位被删除或解析不出时任务失败并提示重新选档位，不再用保存时的旧 agent 继续跑；档位改换 agent 后复用标签只找同一个 agent 的旧标签。 Scheduled tasks now resolve agent, source, account, model and reasoning effort from the current preset in readiness checks, execution and tab reuse; a deleted preset fails the task instead of running the previously saved agent, and a preset that switches agents only reuses tabs of the same agent.
