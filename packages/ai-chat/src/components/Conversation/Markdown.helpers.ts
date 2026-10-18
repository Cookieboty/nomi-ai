/** Markdown 渲染共用的协议白名单辅助函数。
 *  拆出来避免 MarkdownImage 与 Markdown 之间的循环依赖，并方便单测与其它组件复用。*/

/** 链接协议白名单：http/https/mailto；拒绝 javascript:/data:/file: 等。 */
export function sanitizeHref(url: string | null | undefined): string {
  const h = (url ?? '').trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : '';
}

/** 图片 src 协议白名单：https / data:image/ / blob: / chat-asset://；
 *  其它（含 http、file、javascript、cdmodel 等）一律拒绝。*/
export function sanitizeImgSrc(url: string | null | undefined): string {
  const h = (url ?? '').trim();
  return /^(https:\/\/|data:image\/|blob:|chat-asset:\/\/)/i.test(h) ? h : '';
}

/** react-markdown v9+ urlTransform：按节点类型分叉 —— img 走图片白名单，其它走链接白名单。*/
export function urlTransform(url: string, _key: string, node: { tagName?: string }): string {
  if (node?.tagName === 'img') return sanitizeImgSrc(url);
  return sanitizeHref(url);
}
