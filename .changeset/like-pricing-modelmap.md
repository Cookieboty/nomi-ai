---
'@nomi-ai/desktop-go': patch
---

fix(usage): 第三方供应商配了模型映射时，用量费用按公开模型设的「按哪个已知模型处理」计价，不再记为未定价；几个公开模型映射到同一个上游模型而设置不一致时不猜（#256）。/ With a model mapping on a third-party provider, usage cost now uses the "treat as known model" setting of the public model instead of counting the calls as unpriced; when several public models map to one upstream model with different settings, Nomi doesn't guess (#256).
