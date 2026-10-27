import type { Meta } from './types';

/** 两份侧栏会话元数据逐项浅比较（全部字段：名称、时间、后端、标签 id 等都会影响行的渲染） */
function sameMeta(a: Meta, b: Meta): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as Array<keyof Meta>;
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** 列表内容与顺序都未变时返回 true，用于跳过无意义的 setList（保持引用，memo 的行不重渲染） */
export function sameMetaList(a: readonly Meta[], b: readonly Meta[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameMeta(a[i]!, b[i]!)) return false;
  return true;
}
