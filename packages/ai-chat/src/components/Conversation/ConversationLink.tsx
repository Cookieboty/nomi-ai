import React from 'react';

import { useResourceContext, type ResourceImageInfo } from '../../contexts/ResourceContext';
import { resolveConversationFile, useWorkspaceFileIndex } from '../../services/workspaceFileIndex';
import { resourceTarget } from '../../utils/resourceLinks';

import { InsideConversationLinkContext } from './ConversationInlineCode';
import { sanitizeHref } from './Markdown.helpers';

/** Conversation-owned anchor adapter. The host only supplies an open-resource callback. */
export const ConversationLink: React.FC<
  React.AnchorHTMLAttributes<HTMLAnchorElement> & { imageOrigin?: ResourceImageInfo['origin'] }
> = ({ href = '', imageOrigin, children, ...rest }) => {
  const context = useResourceContext();
  const isLocalCandidate = !!context && !!href.trim() && !/^https?:\/\//i.test(href.trim());
  const roots = useWorkspaceFileIndex(isLocalCandidate ? context?.scope : null);
  if (!href.trim()) return <>{children}</>;
  const target = resourceTarget(href);
  if (context && target)
    return (
      <InsideConversationLinkContext.Provider value={true}>
        <a
          {...rest}
          // 宿主的外链脚本见到这个标记就不再转给系统浏览器（这里自己经内核打开），去掉会打开两次
          data-resource-preview="true"
          data-file-link={!target.web && target.path ? 'true' : undefined}
          href={target.web ? href : '#'}
          onClick={(event) => {
            event.preventDefault();
            const resolved =
              !target.web && target.path && !/^(?:\/|~\/|file:\/\/|[A-Za-z]:[\\/])/i.test(href)
                ? resolveConversationFile(href, context.scope, roots)
                : null;
            context.open(resolved?.href ?? href, resolved?.scope ?? context.scope, {
              origin: imageOrigin ?? 'assistant',
            });
          }}
        >
          {children}
        </a>
      </InsideConversationLinkContext.Provider>
    );
  const safe = sanitizeHref(href);
  return safe ? (
    <InsideConversationLinkContext.Provider value={true}>
      <a {...rest} href={safe} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    </InsideConversationLinkContext.Provider>
  ) : (
    <>{children}</>
  );
};
