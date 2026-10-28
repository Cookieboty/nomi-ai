---
'@nomi-ai/host-electron': patch
---

fix(accounts): CLI account login always removes its staging directory (success, failure, cancel, timeout, quit and leftovers from a crash), keeps it 0700/0600, and a cancelled login can no longer save the account.
