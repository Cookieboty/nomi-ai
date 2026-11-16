---
'@nomi-ai/desktop-go': patch
---

fix(delegate): 出错或被停下的委派标签不再 15 分钟后自动关掉，和正常完成的一样闲置一周才关（同 2.3.16），可以一直在里面接着回复；出错标签仍只拆掉常驻进程、保留原会话，下次回复时续接，也仍不拿来给新委派复用，免得被别的任务占走。 Failed or stopped delegation tabs no longer close after 15 minutes; like finished ones they stay open for a week (as in 2.3.16) and keep accepting replies. An errored tab still drops only its resident process and resumes its session on the next reply, and is still not handed to a new delegation so another task can't take it over.
