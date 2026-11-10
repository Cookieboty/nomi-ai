/** Scroll the document viewport only; never move the composer focus or the app hash. */
export function scrollToDocumentFragment(root: HTMLElement, fragment: string): boolean {
  if (!fragment) {
    root.scrollTop = 0;
    return true;
  }
  const heading = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).find(
    (node) => node.id === fragment,
  );
  if (!heading) return false;
  const padding = Number.parseFloat(getComputedStyle(root).paddingTop) || 0;
  root.scrollTop +=
    heading.getBoundingClientRect().top - root.getBoundingClientRect().top - padding;
  return true;
}

export interface DocumentNavigation {
  /** Already decoded by resourceTarget; do not decode it a second time. */
  fragment: string;
  sequence: number;
}
