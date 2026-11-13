---
'@nomi-ai/ai-chat': patch
---

fix(sidebar): pinning a conversation no longer moves it into a separate "Pinned" section. A pinned conversation stays in its own project group (or the ungrouped list, or the flat list when grouping is off) and is sorted to the top of that group; several pinned conversations are ordered by pin time, most recently pinned first, and the rest keep their recency order. Project groups are still ordered by latest activity, so pinning does not reorder projects. Pinned rows show a small pin mark that gives way to the row actions on hover. Existing `pinnedAt` data is reused as is, with no migration.
