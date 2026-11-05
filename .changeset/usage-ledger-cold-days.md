---
---

fix(usage): the usage ledger no longer keeps every record in memory. Only the last ~2 months stay as full records; older days move to per-day files (`userData/usage/ledger-days/`) and are kept in memory as daily totals plus a compact set of key hashes for de-duplication. Memory and startup time now stay bounded as history grows toward the 1-year retention, while totals, charts, the heatmap, per-session costs, details and CSV export return the same results. After a price change, costs for older days are recomputed in the background. Versions before 2.2.1 only see the last ~2 months; the day files are left untouched.
