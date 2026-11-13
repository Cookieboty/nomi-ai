---
'@nomi-ai/contract': patch
---

fix(cli): `cliAccount.remove` accepts `stopExternal` and reports `ACCOUNT_EXTERNAL_BUSY` with the pids still using the account (see cli-thirdparty-effort-login).
