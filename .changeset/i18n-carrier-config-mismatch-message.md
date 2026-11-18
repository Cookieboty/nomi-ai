---
'@nomi-ai/i18n': patch
---

fix(i18n): 续跑时执行配置与档位不一致的提示改为通用措辞：不再点名某个 agent、不再带占位符，也不再描述会发送账号或模型；说明已做的工作保留在工作目录、把档位改回上次的配置后点「继续」或新建任务。 Reword the "execution settings changed" message shown when a task resumes: it no longer names a specific agent, carries no placeholders and no longer hints at sending credentials; it says the work is kept and to restore the previous preset settings and choose Continue, or start a new task.
