---
'@nomi-ai/ai-chat': patch
---

fix(usage): de-duplicating calls that appear both in the local CLI route and in a tool's own session log now matches by request identity instead of "any same-tool log within ±15 s". Route records keep the upstream message / response id (Claude `msg_…` share a key with the log, other ids are matched by suffix), and without a shared id a log is only merged when its session, prompt tokens and output size fit and the route record has not already been claimed by another log (one-to-one, persisted). Independent direct requests that overlap a routed one are no longer silently dropped, and two concurrent routed requests keep their own sessions. When no unique match can be confirmed the log record is kept (it may be counted separately rather than lost).
