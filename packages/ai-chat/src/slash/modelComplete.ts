/**
 * `/model 名字` 的参数补全：命令名后敲空格，列出这个会话能切的模型（与 `/model <参数>` 匹配的
 * 是同一份列表，见 cards.modelArgOptions）。按模型 id 或名称过滤（不区分大小写），前缀命中的排前面。
 */
import { argPhase } from './parse';
import { findCommand } from './registry';
import type { ModelArgOption, SlashCommand } from './types';

export const MODEL_COMMAND = 'model';
/** 列表最多显示多少项（网关模型可能有几百个） */
const MAX_OPTIONS = 50;

/**
 * 输入框是否正在输 `/model` 的参数；返回已输入的部分，否则 null。
 * 整个参数就是一个模型名（显示名可能带空格，如「Opus 5.5」），所以敲了空格也继续补全。
 */
export function modelArgQuery(input: string, commands: readonly SlashCommand[]): string | null {
  const a = argPhase(input);
  if (!a || /\n/.test(a.args)) return null;
  const c = findCommand(commands, a.name);
  if (!c || c.name !== MODEL_COMMAND || c.source !== 'builtin' || c.disabled) return null;
  return a.args;
}

export function filterModelOptions(
  options: readonly ModelArgOption[] | null,
  query: string,
): ModelArgOption[] {
  const q = query.trim().toLowerCase();
  if (!options) return [];
  if (!q) return options.slice(0, MAX_OPTIONS);
  const rank = (o: ModelArgOption) => {
    const v = o.value.toLowerCase();
    const l = o.label.toLowerCase();
    if (v.startsWith(q) || l.startsWith(q)) return 0;
    // `供应商/模型` 里模型名的前缀也算前缀命中
    if (v.split('/').some((p) => p.startsWith(q))) return 1;
    return v.includes(q) || l.includes(q) ? 2 : -1;
  };
  return options
    .map((o) => ({ o, r: rank(o) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .slice(0, MAX_OPTIONS)
    .map((x) => x.o);
}
