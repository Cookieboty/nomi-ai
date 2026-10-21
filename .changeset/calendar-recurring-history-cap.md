---
'@nomi-ai/ai-chat': patch
---

fix(calendar): long-running recurring events (for example a daily event that started more than 500 days ago) no longer disappear from the current calendar. The 500-occurrence safety limit now counts only occurrences returned for the queried time range, not past ones, and unbounded rules jump straight to the queried range.
