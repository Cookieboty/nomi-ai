---
'@nomi-ai/desktop-go': patch
---

chore: exercise conversation runtime recovery and fenced lifecycle with fake adapters

Add an in-memory conversation-owned runtime controller with explicit resume/new/fallback/unknown/error outcomes, delivery-gated coverage, generation-fenced streaming and approvals, conservative permissions, explicit FIFO admission, and cancellation uncertainty. Fix retry planning so an older logical request does not silently clip intervening history. Production chat, CLI adapters, user data, and persistent migration remain unchanged.
