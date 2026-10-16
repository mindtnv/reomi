export const NOTE_TAG_MAX_LENGTH = 128;
export const NOTE_TAG_MAX_COUNT = 100;

export type NoteTagErrorCode = 'tag_too_long' | 'too_many_tags';

export class NoteTagError extends Error {
  constructor(readonly code: NoteTagErrorCode) {
    super(code);
    this.name = 'NoteTagError';
  }
}

/** One note-tag list for every write path.
 *  Commas split. Whitespace collapses, including newlines. Other C0 controls
 *  and DEL are removed. NFC. Case stays. Exact duplicates drop, first wins.
 *  A missing tag list is empty. Over-long or too many tags is an error. */
export function normalizeNoteTags(input: string | readonly string[]): { ok: true; tags: string[] } | { ok: false; error: NoteTagErrorCode } {
  const parts = typeof input === 'string' ? [input] : input;
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const piece of part.split(',')) {
      const tag = piece
        .replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, '')
        .normalize('NFC')
        .replace(/\s+/gu, ' ')
        .trim();
      if (!tag) continue;
      if (tag.length > NOTE_TAG_MAX_LENGTH) return { ok: false, error: 'tag_too_long' };
      if (seen.has(tag)) continue;
      if (tags.length >= NOTE_TAG_MAX_COUNT) return { ok: false, error: 'too_many_tags' };
      seen.add(tag);
      tags.push(tag);
    }
  }
  return { ok: true, tags };
}
