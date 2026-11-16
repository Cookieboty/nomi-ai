import { Icon } from '@nomi-ai/ui';
import { IconFileCode2 as FileCode2 } from '@tabler/icons-react';
import React, { createContext, useContext } from 'react';

import { useResourceContext } from '../../contexts/ResourceContext';
import { resolveConversationFile, useWorkspaceFileIndex } from '../../services/workspaceFileIndex';

import styles from './Markdown.module.css';

/** 当 <code> 已经处于 <a> 内部（如 [`label`](path)）时，不再重复绑定文件点击交互 */
export const InsideConversationLinkContext = createContext(false);

export const ConversationInlineCode: React.FC<
  React.HTMLAttributes<HTMLElement> & { text: string }
> = ({ text, children, className, ...rest }) => {
  const insideLink = useContext(InsideConversationLinkContext);
  const context = useResourceContext();
  const roots = useWorkspaceFileIndex(insideLink ? null : context?.scope);

  const resolved =
    !insideLink && context ? resolveConversationFile(text, context.scope, roots) : null;

  if (!resolved || !context) {
    return (
      <code className={`${styles.inlineCode} ${className ?? ''}`.trim()} {...rest}>
        {children}
      </code>
    );
  }

  const openFile = (event: React.MouseEvent | React.KeyboardEvent) => {
    // 允许用户拖选复制行内代码文字，不误触打开
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
    event.preventDefault();
    event.stopPropagation();
    context.open(resolved.href, resolved.scope, { origin: 'assistant' });
  };

  return (
    <code
      {...rest}
      role="button"
      tabIndex={0}
      data-resource-preview="true"
      data-file-code="true"
      className={`${styles.inlineCode} ${styles.fileCode} ${className ?? ''}`.trim()}
      onClick={openFile}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          openFile(event);
        }
      }}
    >
      <Icon icon={FileCode2} size={13} className={styles.fileCodeIcon} />
      {children}
    </code>
  );
};
