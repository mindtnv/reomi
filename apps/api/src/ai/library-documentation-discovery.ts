import { documentationRuleSelected, preferDocVersions, type DocumentationManifest, type DocumentationPage, type DocumentationSection } from '@reomi/shared';
import { buildSeedIndex } from './docs-index';
import { assertPublicHost, validatePageUrl } from './page-reader';

export function normalizeDocumentationRoot(raw: string): string {
  const url = validatePageUrl(raw.trim());
  url.search = ''; url.hash = '';
  url.pathname = url.pathname.replace(/\/(?:home|index)(?:\.html?)?\/?$/i, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export function documentationUrlKey(raw: string): string {
  const url = new URL(raw); url.hash = ''; url.search = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

export function documentationLabel(path: string): string {
  const last = path.split('/').filter(Boolean).pop() ?? 'Documentation';
  try { return decodeURIComponent(last).replace(/[-_]/g, ' ').slice(0, 100); } catch { return last.slice(0, 100); }
}

export async function discoverDocumentation(raw: string, locale: 'en' | 'ru'): Promise<DocumentationManifest> {
  const rootUrl = normalizeDocumentationRoot(raw), root = new URL(rootUrl);
  await assertPublicHost(root);
  const index = await buildSeedIndex({ origin: root.origin, host: root.hostname, path: root.pathname }, locale);
  const preferred = new Set(preferDocVersions(index.map(p => p.url), null));
  const seen = new Set<string>();
  const pages: DocumentationPage[] = [];
  for (const entry of index) {
    const url = validatePageUrl(entry.url);
    if (url.origin !== root.origin || !preferred.has(entry.url)) continue;
    const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    if (!path.startsWith(root.pathname) || /\/(?:blog|tags?|home|index(?:\.html?)?)\/$/i.test(path)) continue;
    const key = documentationUrlKey(url.href);
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = url.pathname.split('/').filter(Boolean);
    const parent = `/${parts.slice(0, -1).join('/')}/`.replace(/^\/\/$/, '/');
    pages.push({ url: key, title: (entry.title || documentationLabel(url.pathname)).slice(0, 300),
      section: parent.startsWith(root.pathname) ? parent : root.pathname });
  }
  const effectiveLocale = pages.length && /^\/ru(?:\/|$)/.test(new URL(pages[0]!.url).pathname) ? 'ru' : 'en';
  return { rootUrl, locale: effectiveLocale, pages };
}

export function documentationSections(manifest: DocumentationManifest): DocumentationSection[] {
  const root = new URL(manifest.rootUrl).pathname;
  const counts = new Map<string, number>();
  for (const page of manifest.pages) {
    let prefix = page.section;
    while (prefix.startsWith(root)) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      if (prefix === root) break;
      prefix = `/${prefix.split('/').filter(Boolean).slice(0, -1).join('/')}/`.replace(/^\/\/$/, '/');
    }
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, pageCount]) => ({
    prefix, pageCount, title: documentationLabel(prefix),
    parent: prefix === root ? null : `/${prefix.split('/').filter(Boolean).slice(0, -1).join('/')}/`.replace(/^\/\/$/, '/'),
    reference: /\/(?:reference|kubernetes-api|api-reference|glossary)\//.test(prefix),
  }));
}

export function selectedDocumentationPages(manifest: DocumentationManifest, prefixes: string[]): DocumentationPage[] {
  const known = new Set(documentationSections(manifest).map(s => s.prefix));
  if (!prefixes.length || prefixes.some(p => !known.has(p.startsWith('!') ? p.slice(1) : p))) throw new Error('invalid_sections');
  const selected = manifest.pages.filter(page => documentationRuleSelected(page.section, prefixes));
  if (!selected.length) throw new Error('invalid_sections');
  return selected;
}
