# 发版说明模板

`docs/releases/vX.Y.Z.md` 是 GitHub Release 正文，也写进该版本的 `latest-go.json`。应用内弹层按界面语言取一半（`packages/ai-chat/src/releaseNotes/index.ts`）。

新说明用这一版。2.3.9 及更早的文件保持每行「中文 / English」，不要回改。

## 怎么写

1. 标题下一行只讲这一次真正改变用法的事。一句人话。
2. 下面用短句列用户能感知的变化。中文在前，动词开头。不要把每条写成中英对译墙。
3. 需要展开的修复和边界放进「细节」。
4. 英文整段放在 `## English` 之后。这一行必须独占，前后不要加别的字。弹层看到它就切开。
5. 不写还没有的能力。终端或 IDE 里已开的会话是只读的；故障切换仍用同一个模型；没有按任务路由模型，也没有热切换。
6. 名称写 Nomi·诺米。不要写成 `Nomi · 诺米`。

## 模板

```markdown
# Nomi·诺米 X.Y.Z

一句话：这次让人换了一种用法。

- 短句一。
- 短句二。

## 细节

- 需要展开的修复，仍用短句。

## English

One sentence: what changed.

- Short point.
- Short point.

## Details

- The longer fix, still one sentence.
```
