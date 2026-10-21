import { assistantApi as api, ok } from './api';
import { documentationRuleSelected, type DocumentationSection, type DocumentationState } from '@reomi/shared';

export interface DocumentationPreview {
  id: string; rootUrl: string; title: string; locale: 'en' | 'ru'; total: number; available: number;
  expiresAt: string | Date; sections: (DocumentationSection & { newPageCount: number })[];
}
export interface DocumentationCollection {
  id: string; rootUrl: string; title: string; locale: 'en' | 'ru'; folderId: string | null;
  state: DocumentationState; errorCode: string | null; checkedAt: string | Date | null; updatedAt: string | Date;
  total: number; completed: number; pending: number; failed: number; deleted: number;
}
export const documentationApi = {
  async list(): Promise<{ items: DocumentationCollection[] }> { return ok(await api.library.documentation.get()); },
  async preview(url: string, locale: 'en' | 'ru'): Promise<DocumentationPreview> { return ok(await api.library.documentation.preview.post({ url, locale })); },
  async confirm(id: string, title: string, prefixes: string[]): Promise<DocumentationCollection> { return ok(await api.library.documentation({ id }).confirm.post({ title, prefixes })); },
  async update(id: string): Promise<DocumentationCollection> { return ok(await api.library.documentation({ id }).updates.post()); },
  async cancel(id: string): Promise<DocumentationCollection> { return ok(await api.library.documentation({ id }).cancel.post()); },
  async disconnect(id: string) { return ok(await api.library.documentation({ id }).delete()); },
  async errors(id: string) { return ok(await api.library.documentation({ id }).errors.get()); },
};

/** Ancestor selections cover descendants once, including mixed direct/child pages. */
export function documentationSelection(preview: DocumentationPreview, prefixes: Set<string>) {
  let pages = 0, added = 0;
  const children = new Map<string | null, { pages: number; added: number }>();
  for (const section of preview.sections) {
    const total = children.get(section.parent) ?? { pages: 0, added: 0 };
    total.pages += section.pageCount; total.added += section.newPageCount; children.set(section.parent, total);
  }
  for (const section of preview.sections) {
    if (!documentationRuleSelected(section.prefix, [...prefixes])) continue;
    pages += section.pageCount - (children.get(section.prefix)?.pages ?? 0);
    added += section.newPageCount - (children.get(section.prefix)?.added ?? 0);
  }
  return { pages, added };
}
