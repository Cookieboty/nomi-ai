export interface PreviewPathCrumb {
  name: string;
  path: string;
  directory: string;
}
/** Literal filesystem paths; no URL decoding or workspace-relative substitution. */
export function previewPathCrumbs(input: string): PreviewPathCrumb[] {
  const path = input.replace(/\\/g, '/');
  const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '';
  const parts = path.slice(prefix.length).split('/').filter(Boolean);
  return parts
    .map((name, index) => ({
      name,
      path: prefix + parts.slice(0, index + 1).join('/'),
      directory:
        index === parts.length - 1
          ? prefix + parts.slice(0, index).join('/')
          : prefix + parts.slice(0, index + 1).join('/'),
    }))
    .map((crumb) => ({
      ...crumb,
      directory: /^[A-Za-z]:$/.test(crumb.directory) ? `${crumb.directory}/` : crumb.directory,
    }));
}
