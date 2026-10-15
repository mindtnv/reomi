import type { CardSourceLink } from './types';
export function cardSourceHref(item: CardSourceLink): string | null {
  if (item.sourceKind === 'youtube' && item.sourceUrl) {
    try {
      const url = new URL(item.sourceUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        if (item.startSeconds != null) url.searchParams.set('t', String(item.startSeconds));
        return url.toString();
      }
    } catch {
      return null;
    }
  }
  if (!item.sourceId) return null;
  const params = new URLSearchParams();
  if (item.locationAvailable !== false) {
    if (item.sourceChunkId) params.set('chunk',item.sourceChunkId);
    if (item.position != null) params.set('pos',String(item.position));
    if (item.page != null) params.set('page',String(item.page));
  }
  return `/library/${item.sourceId}${params.size?`?${params}`:''}`;
}

export function followCardSourceHref(href: string, push: (href: string) => void): void {
  if (/^https?:\/\//i.test(href)) {
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  push(href);
}
