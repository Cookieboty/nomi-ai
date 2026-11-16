---
'@nomi-ai/ai-chat': patch
---

fix(ui): 回访启动的品牌开屏不会再一直卡住：单个启动任务最多等 5 秒、字体就绪最多等 1.5 秒、窗口不可见时排版两帧按时间兜底，开屏总时限 8 秒；「跳过」在等待数据时也立刻收起，会话与侧栏在后台继续加载；启动时新建 / 清空会话打断历史加载也会报告完成。 The returning-user brand splash can no longer hang: each startup task is given up after 5 s, font readiness after 1.5 s, layout frames fall back to a timer when the window is hidden, and the whole splash closes after 8 s; Skip closes it immediately even while data is loading (loading continues in the background), and a new / cleared conversation that supersedes the startup history load still reports it done.
