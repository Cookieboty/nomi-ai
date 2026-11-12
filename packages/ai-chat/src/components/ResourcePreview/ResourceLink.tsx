import React from 'react';

import { useResourceContext, type ResourceImageInfo } from '../../contexts/ResourceContext';
import { resourceTarget, resolveDocumentHref } from '../../utils/resourceLinks';

import { scrollToDocumentFragment } from './documentNavigation';
import { usePreviewDocumentLocation } from './PreviewDocumentContext';
import { sanitizeHref } from './PreviewMarkdown.helpers';

export const ResourceLink: React.FC<
  React.AnchorHTMLAttributes<HTMLAnchorElement> & { imageOrigin?: ResourceImageInfo['origin'] }
> = ({ href = '', imageOrigin, children, ...rest }) => {
  const context = useResourceContext();
  const document = usePreviewDocumentLocation();
  // ReactMarkdown sanitizes rejected protocols to an empty URL. It is not a file.
  if (!href.trim()) return <>{children}</>;
  if (href.startsWith('#'))
    return (
      <a
        {...rest}
        href={href}
        onMouseDown={(e) => {
          rest.onMouseDown?.(e);
          if (e.button === 0) e.preventDefault();
        }}
        onClick={(e) => {
          e.preventDefault();
          const root = e.currentTarget.closest<HTMLElement>('[data-resource-document]');
          if (!root) return;
          try {
            scrollToDocumentFragment(root, decodeURIComponent(href.slice(1)));
          } catch {
            // A malformed fragment must not navigate the host application's URL.
          }
        }}
      >
        {children}
      </a>
    );
  const pathLike = !/^[a-z][a-z\d+.-]*:/i.test(href) || !!resourceTarget(href)?.path;
  const resolved =
    document.directory && pathLike ? resolveDocumentHref(document.directory, href) : href;
  const target = resourceTarget(resolved);
  if (context && target)
    return (
      <a
        {...rest}
        // 宿主的外链脚本见到这个标记就不再转给系统浏览器（这里自己经内核打开），去掉会打开两次
        data-resource-preview="true"
        href={target.web ? resolved : '#'}
        onMouseDown={(e) => {
          rest.onMouseDown?.(e);
          if (e.button === 0 && target.fragment !== undefined) e.preventDefault();
        }}
        onClick={(e) => {
          e.preventDefault();
          if (target.fragment !== undefined && target.path === document.path) {
            const root = e.currentTarget.closest<HTMLElement>('[data-resource-document]');
            if (root) {
              scrollToDocumentFragment(root, target.fragment);
              return;
            }
          }
          context.open(resolved, context.scope, {
            origin: imageOrigin ?? 'document',
          });
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
