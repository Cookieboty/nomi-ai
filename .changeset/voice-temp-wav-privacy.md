---
'@nomi-ai/desktop-go': patch
---

fix(voice): 本地 whisper.cpp 识别写入的临时录音文件改为仅当前用户可读；语音隐私说明如实写明本地识别会短暂写临时文件、结束即删除（#271）。/ The temporary recording that local whisper.cpp recognition writes is now readable by the current user only, and the voice privacy notes now state that local recognition briefly writes a temp file that is deleted afterwards (#271).
