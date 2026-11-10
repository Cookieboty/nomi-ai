/** File-preview Markdown only. No conversation reports, citations or streaming. */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { Check, Copy } from 'lucide-react';
import React, { lazy, Suspense, memo, useEffect, useState, useSyncExternalStore } from 'react';
import type { Components } from 'react-markdown';

import {
  isHighlighterReady,
  loadHighlighter,
  rehypeHighlightShared,
  subscribeHighlighter,
} from './markdownHighlight';
import { LARGE_MARKDOWN_SIZE } from './markdownParseClient';
import { PreviewImage } from './PreviewImage';
import styles from './PreviewMarkdown.module.css';
import { PreviewMarkdownContent } from './PreviewMarkdownContent';
import { sourceRangeProps } from './previewSourceRanges';
import { ResourceLink } from './ResourceLink';

const LazyMermaid = lazy(() =>
  import('./MermaidDiagram').then((m) => ({ default: m.MermaidDiagram })),
);

const CodeBlock: React.FC<{
  lang: string;
  code: string;
  highlightedHtml?: string;
  sourceRange?: Record<string, unknown>;
}> = ({ lang, code, highlightedHtml, sourceRange }) => {
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
  if (lang.toLowerCase() === 'mermaid') {
    return (
      <div {...sourceRange}>
        <Suspense
          fallback={
            <pre className={styles.codePre}>
              <code>{code}</code>
            </pre>
          }
        >
          <LazyMermaid code={code} />
        </Suspense>
      </div>
    );
  }
  return (
    <div className={styles.codeBlock} data-testid="md-code" {...sourceRange}>
      <div className={styles.codeHead} data-preview-find-ignore>
        <span>{lang || t('ui.usage-tools.code')}</span>
        <button
          type="button"
          className={styles.copyBtn}
          onClick={copy}
          aria-label={t('ui.usage-tools.copy-code')}
          title={t('ui.usage-tools.copy-code')}
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

export const previewMarkdownComponents: Components = {
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
      return (
        <CodeBlock
          lang={lang}
          code={text}
          highlightedHtml={html}
          sourceRange={sourceRangeProps(child.props as Record<string, unknown>)}
        />
      );
    }
    return <pre className={styles.codePre}>{children}</pre>;
  },
  a(props) {
    const { node, ...rest } = props;
    void node;
    return <ResourceLink {...rest} />;
  },
  img(props) {
    const { src, alt } = props as { src?: string; alt?: string };
    return <PreviewImage src={src ?? ''} alt={alt} />;
  },
  table(props) {
    const position = props.node?.position;
    const length = (position?.end.offset ?? 0) - (position?.start.offset ?? 0);
    const rows =
      props.node?.children.reduce(
        (count, section) =>
          count +
          (section.type === 'element'
            ? section.children.filter((row) => row.type === 'element' && row.tagName === 'tr')
                .length
            : 0),
        0,
      ) ?? 0;
    // Only an initial offscreen estimate. The browser remembers the actual height
    // after laying out a table, without unmounting editable/selectable cells.
    const estimate = Math.max(16, rows * 2, Math.ceil(length / 60));
    return (
      <div
        className={styles.tableWrap}
        data-preview-lazy-table
        style={{ '--preview-table-lines': estimate } as React.CSSProperties}
      >
        <table>{props.children}</table>
      </div>
    );
  },
  // File documents keep semantic H1–H6 without conversation heading compression.
  h1: (p) => <h1 {...sourceRangeProps(p as Record<string, unknown>)}>{p.children}</h1>,
  h2: (p) => <h2 {...sourceRangeProps(p as Record<string, unknown>)}>{p.children}</h2>,
  h3: (p) => <h3 {...sourceRangeProps(p as Record<string, unknown>)}>{p.children}</h3>,
  h4: (p) => <h4 {...sourceRangeProps(p as Record<string, unknown>)}>{p.children}</h4>,
  h5: (p) => <h5 {...sourceRangeProps(p as Record<string, unknown>)}>{p.children}</h5>,
  h6: (p) => <h6 {...sourceRangeProps(p as Record<string, unknown>)}>{p.children}</h6>,
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

const REHYPE_HIGHLIGHT = [rehypeHighlightShared];
const REHYPE_NONE: never[] = [];

export const PreviewMarkdown = memo(function PreviewMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  useLocale();
  const ready = useSyncExternalStore(subscribeHighlighter, isHighlighterReady, () => false);
  useEffect(() => {
    if (!ready && /^ {0,3}(?:`{3,}|~{3,})[^\s`~]+/m.test(text)) void loadHighlighter();
  }, [text, ready]);
  return (
    <div
      className={`${styles.md} ${className ?? ''}`}
      data-testid="markdown"
      data-preview-large-markdown={text.length >= LARGE_MARKDOWN_SIZE || undefined}
    >
      <PreviewMarkdownContent
        text={text}
        rehypePlugins={ready ? REHYPE_HIGHLIGHT : REHYPE_NONE}
        components={previewMarkdownComponents}
      />
    </div>
  );
});
