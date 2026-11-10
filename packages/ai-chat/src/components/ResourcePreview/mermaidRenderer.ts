import type Mermaid from 'mermaid';
import type { MermaidConfig } from 'mermaid';

export interface DiagramTheme {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  font: string;
  dark: boolean;
}
let engine: Promise<typeof Mermaid> | undefined;
const QUEUE_KEY = Symbol.for('nomi.mermaid-render-queue');
type QueueHost = typeof globalThis & { [QUEUE_KEY]?: Promise<unknown> };
const queueHost = globalThis as QueueHost;
queueHost[QUEUE_KEY] ??= Promise.resolve();
let sequence = 0;
const MAX_SOURCE = 50_000;

export function diagramTheme(): DiagramTheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const background = token('--cd-color-bg-subtle');
  return {
    background,
    surface: token('--cd-color-surface'),
    text: token('--cd-color-text'),
    muted: token('--cd-color-text-muted'),
    border: token('--cd-color-border-strong'),
    accent: token('--cd-color-accent-strong'),
    font: token('--cd-font-sans'),
    dark: ['dark', 'graphite', 'ink'].includes(document.documentElement.dataset.theme ?? ''),
  };
}

/** Diagram config stays application-owned; document directives cannot relax trust or inject CSS. */
export function diagramConfig(theme: DiagramTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    logLevel: 'fatal',
    htmlLabels: false,
    maxTextSize: MAX_SOURCE,
    maxEdges: 500,
    theme: 'base',
    fontFamily: theme.font,
    secure: [
      'securityLevel',
      'startOnLoad',
      'suppressErrorRendering',
      'maxTextSize',
      'maxEdges',
      'theme',
      'themeVariables',
      'themeCSS',
      'htmlLabels',
      'fontFamily',
      'secure',
    ],
    flowchart: { htmlLabels: false },
    themeVariables: {
      darkMode: theme.dark,
      background: theme.background,
      primaryColor: theme.surface,
      primaryTextColor: theme.text,
      primaryBorderColor: theme.border,
      secondaryColor: theme.background,
      secondaryTextColor: theme.text,
      tertiaryColor: theme.surface,
      tertiaryTextColor: theme.text,
      lineColor: theme.muted,
      textColor: theme.text,
      mainBkg: theme.surface,
      nodeBorder: theme.border,
      clusterBkg: theme.background,
      clusterBorder: theme.border,
      edgeLabelBackground: theme.background,
      titleColor: theme.text,
      actorBkg: theme.surface,
      actorTextColor: theme.text,
      actorBorder: theme.border,
      actorLineColor: theme.muted,
      signalColor: theme.text,
      signalTextColor: theme.text,
      labelBoxBkgColor: theme.surface,
      labelBoxBorderColor: theme.border,
      labelTextColor: theme.text,
      noteBkgColor: theme.surface,
      noteTextColor: theme.text,
      noteBorderColor: theme.accent,
      activationBkgColor: theme.background,
      activationBorderColor: theme.border,
      fontFamily: theme.font,
    },
  };
}

/** A second SVG-only boundary; no links, callbacks, foreign HTML or external asset references. */
export async function sanitizeDiagram(svg: string): Promise<string> {
  const { default: purifier } = await import('dompurify');
  const clean = purifier.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      'foreignObject',
      'script',
      'iframe',
      'a',
      'image',
      'use',
      'animate',
      'set',
      'animateTransform',
    ],
    FORBID_ATTR: ['href', 'xlink:href', 'target'],
    RETURN_DOM_FRAGMENT: true,
  });
  const scrub = (css: string) => {
    // CSS escapes can spell url/@import; generated Mermaid styles do not need them.
    if (css.includes('\\')) return '';
    return css.replace(/@import\s[^;]+;?/gi, '').replace(/url\(([^)]*)\)/gi, (_, raw: string) => {
      const value = raw.trim().replace(/^['"]|['"]$/g, '');
      return /^#[\w:.-]+$/.test(value) ? `url(${value})` : 'none';
    });
  };
  for (const node of clean.querySelectorAll('*')) {
    if (node.tagName.toLowerCase() === 'style') node.textContent = scrub(node.textContent ?? '');
    for (const attr of Array.from(node.attributes)) {
      if (attr.name === 'style' || /url\(/i.test(attr.value))
        node.setAttribute(attr.name, scrub(attr.value));
    }
  }
  const result = clean.querySelector('svg');
  if (!result) throw new Error('Missing diagram');
  return new XMLSerializer().serializeToString(result);
}

/** Mermaid has global configuration; serialize initialization + render across all messages. */
export function renderDiagram(
  code: string,
  theme: DiagramTheme,
  cancelled = () => false,
): Promise<string> {
  if (code.length > MAX_SOURCE) return Promise.reject(new Error('Diagram too large'));
  // Retain normal Mermaid syntax, but do not accept document-controlled init/config directives.
  const source = code.replace(/%%\{[\s\S]*?\}%%/g, '');
  if (/@\{[^}]*\bimg\s*:/i.test(source) || /!\[[^\]]*\]\s*\(/.test(source))
    return Promise.reject(new Error('Diagram images are not allowed'));
  if (/^\s*---(?:\r?\n|$)/.test(source))
    return Promise.reject(new Error('Diagram config is not allowed'));
  const work = (queueHost[QUEUE_KEY] ?? Promise.resolve()).then(async () => {
    if (cancelled()) return '';
    engine ??= import('mermaid')
      .then((m) => m.default)
      .catch((error) => {
        engine = undefined;
        throw error;
      });
    const mermaid = await engine;
    if (cancelled()) return '';
    const scratch = document.createElement('div');
    scratch.setAttribute('aria-hidden', 'true');
    scratch.style.cssText =
      'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
    document.body.append(scratch);
    try {
      mermaid.initialize(diagramConfig(theme));
      const { svg } = await mermaid.render(`nomi-preview-diagram-${++sequence}`, source, scratch);
      if (cancelled()) return '';
      return await sanitizeDiagram(svg);
    } finally {
      scratch.remove();
    }
  });
  queueHost[QUEUE_KEY] = work.catch(() => undefined);
  return work;
}
