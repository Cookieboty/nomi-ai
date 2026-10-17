/** 助手正文的 Markdown 渲染：react-markdown + remark-gfm + rehype-highlight；
 *  components 覆盖以维持代码块复制按钮、链接协议白名单、图片放大能力。 */
import { Icon, t } from '@nomi-ai/ui';
import { Check, Copy } from 'lucide-react';
import React, { memo, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { splitMarkdownChunks } from '../../utils/markdown';

import { sanitizeHref, urlTransform } from './Markdown.helpers';
import styles from './Markdown.module.css';
import { MarkdownImage } from './MarkdownImage';

const CodeBlock: React.FC<{ lang: string; code: string; highlightedHtml?: string }> = ({
  lang,
  code,
  highlightedHtml,
}) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <div className={styles.codeBlock} data-testid="md-code">
      <div className={styles.codeHead}>
        <span>{lang || t('代码')}</span>
        <button
          type="button"
          className={styles.copyBtn}
          onClick={copy}
          aria-label={t('复制代码')}
          title={t('复制代码')}
        >
          <Icon icon={copied ? Check : Copy} size={13} />
        </button>
      </div>
      <pre className={styles.codePre}>
        {highlightedHtml ? (
          <code
            className={`hljs language-${lang || 'plaintext'}`}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
};

/** 从 rehype-highlight 已高亮好的 <code> 子树取出纯文本（供复制按钮使用）。*/
function toText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return toText(node.props.children);
  }
  return '';
}

/** rehype-highlight 把语言写在 <code class="language-xxx hljs"> 上，提取之。*/
function langFromClassName(className?: string): string {
  if (!className) return '';
  const m = /\blanguage-([\w+#.-]+)/i.exec(className);
  return m?.[1] ?? '';
}

const components: Components = {
  // 代码：行内直出；代码块（有 language-* class 或多行）走 CodeBlock
  code(props) {
    const { className, children, node, ...rest } = props as React.HTMLAttributes<HTMLElement> & {
      className?: string;
      node?: unknown;
    };
    void node;
    const lang = langFromClassName(className);
    const text = toText(children);
    const isBlock = Boolean(lang) || text.includes('\n');
    if (!isBlock) {
      return (
        <code className={styles.inlineCode} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  // 把 <pre><code> 整体替换为我们的带复制按钮的 CodeBlock
  pre(props) {
    const { children } = props;
    const child = React.Children.toArray(children)[0];
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
      const lang = langFromClassName(child.props.className);
      const text = toText(child.props.children);
      // 若 rehype-highlight 已把文本解析为 <span class="hljs-..."> 子节点，这里把它们序列化成 HTML
      // 再交给 CodeBlock 内的 <code dangerouslySetInnerHTML>，避免丢失高亮颜色。
      const html = serializeHljsChildren(child.props.children);
      return <CodeBlock lang={lang} code={text} highlightedHtml={html} />;
    }
    return <pre className={styles.codePre}>{children}</pre>;
  },
  a(props) {
    const { href, children, ...rest } = props;
    const safe = sanitizeHref(href ?? '');
    if (!safe) return <>{children}</>;
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener" {...rest}>
        {children}
      </a>
    );
  },
  img(props) {
    const { src, alt } = props as { src?: string; alt?: string };
    return <MarkdownImage src={src ?? ''} alt={alt} />;
  },
  table(props) {
    return (
      <div className={styles.tableWrap}>
        <table>{props.children}</table>
      </div>
    );
  },
  // 标题视觉降一级，与旧实现一致（避免正文里出现过大的 h1）
  h1: (p) => <h2>{p.children}</h2>,
  h2: (p) => <h3>{p.children}</h3>,
  h3: (p) => <h4>{p.children}</h4>,
  h4: (p) => <h5>{p.children}</h5>,
  h5: (p) => <h6>{p.children}</h6>,
  h6: (p) => <h6>{p.children}</h6>,
  li(props) {
    const { className, children, ...rest } = props as React.LiHTMLAttributes<HTMLLIElement> & {
      className?: string;
    };
    // remark-gfm 的任务列表 li 带 className="task-list-item"
    const task = className?.includes('task-list-item');
    return (
      <li className={task ? styles.task : undefined} {...rest}>
        {children}
      </li>
    );
  },
};

/** 把 rehype-highlight 产出的高亮子树序列化为 HTML 字符串，供 CodeBlock 的 <code> 使用。
 *  只允许 <span class="hljs-*"> 这一种结构（rehype-highlight 的输出模式），其它元素忽略成文本，
 *  值一律做 HTML 转义，杜绝注入。*/
function serializeHljsChildren(nodes: React.ReactNode): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const walk = (n: React.ReactNode): string => {
    if (n == null || typeof n === 'boolean') return '';
    if (typeof n === 'string' || typeof n === 'number') return escape(String(n));
    if (Array.isArray(n)) return n.map(walk).join('');
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(n)) {
      const type = n.type;
      const cls = typeof n.props.className === 'string' ? n.props.className : '';
      if (typeof type === 'string' && type === 'span' && /\bhljs-[\w-]+\b/.test(cls)) {
        return `<span class="${escape(cls)}">${walk(n.props.children)}</span>`;
      }
      return walk(n.props.children);
    }
    return '';
  };
  return walk(nodes);
}

/** 一段（块边界之间）的渲染：文本不变就不重新解析 / 渲染；流式输出时只有最后一段在变 */
const MarkdownChunk = memo(function MarkdownChunk({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      urlTransform={urlTransform}
      components={components}
      skipHtml
    >
      {text}
    </ReactMarkdown>
  );
});

export const Markdown: React.FC<{ text: string; className?: string }> = memo(
  ({ text, className }) => {
    const chunks = useMemo(() => splitMarkdownChunks(text), [text]);
    return (
      <div className={`${styles.md} ${className ?? ''}`} data-testid="markdown">
        {chunks.map((c, i) => (
          <MarkdownChunk key={i} text={c} />
        ))}
      </div>
    );
  },
);
Markdown.displayName = 'Markdown';
