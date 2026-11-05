---
'@nomi-ai/contract': minor
---

feat(providers): 第三方供应商链接接入（docs/design/provider-link.md）：网页上的 `nomi://provider/import` 一键导入地址与 Key（兼容 Cherry Studio 的格式），`nomi://provider/connect` 走网页授权（PKCE，Key 不出现在链接里）；「设置 → 模型与供应商」可填网址发起授权。都要在 Nomi 里确认后才保存，同地址的更新已有的第三方供应商。Node 与 Go 两个版本一致。确认框只写能核实的来源（链接导入不显示链接自带的网站名）；开着代理软件 fake-ip 时也能授权；添加后自动拉取模型列表。
