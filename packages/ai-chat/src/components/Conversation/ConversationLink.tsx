import React from 'react';

import { useResourceContext, type ResourceImageInfo } from '../../contexts/ResourceContext';
import { resourceTarget } from '../../utils/resourceLinks';

import { sanitizeHref } from './Markdown.helpers';

/** Conversation-owned anchor adapter. The host only supplies an open-resource callback. */
export const ConversationLink: React.FC<
  React.AnchorHTMLAttributes<HTMLAnchorElement> & { imageOrigin?: ResourceImageInfo['origin'] }
> = ({ href = '', imageOrigin, children, ...rest }) => {
  const context = useResourceContext();
  if (!href.trim()) return <>{children}</>;
  const target = resourceTarget(href);
  if (context && target)
    return (
      <a
        {...rest}
        // 宿主的外链脚本见到这个标记就不再转给系统浏览器（这里自己经内核打开），去掉会打开两次
        data-resource-preview="true"
        href={target.web ? href : '#'}
        onClick={(event) => {
          event.preventDefault();
          context.open(href, context.scope, { origin: imageOrigin ?? 'assistant' });
        }}
      >
        {children}
      </a>
    );
  const safe = sanitizeHref(href);
  return safe ? (
    <a {...rest} href={safe} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
};
