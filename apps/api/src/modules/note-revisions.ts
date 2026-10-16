// Pre-images of an existing note document. Creates do not write a row.
// Callers already hold the user revision lock and the note row lock.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, noteRevisions, noteTypes, notes, type Db } from '@reomi/db';
import { fieldPlainText, type FieldValues, type NoteField } from '@reomi/shared';

export const NOTE_REVISION_MAX_BYTES = 262144;
export const NOTE_REVISIONS_PER_NOTE = 5;
export const NOTE_REVISIONS_PER_USER = 1000;
/** Salt 941 on the bare user id. Note-operation receipts use 941 on a different key. 942 is ui-action receipts. */
export const USER_REVISION_LOCK_SALT = 941;

export type NoteDocument = {
  acceptedAnswers: string[];
  fieldValues: FieldValues;
  noteTypeId: string;
  tags: string[];
};

type RevisionTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type LockedNoteDocument = NoteDocument & {
  id: string;
  userId: string;
  updatedAt: Date;
};

export type NoteDocumentPatch = {
  fieldValues?: FieldValues;
  tags?: string[];
  acceptedAnswers?: string[];
  noteTypeId?: string;
  updatedAt: Date;
};

/** Canonical object key order is acceptedAnswers, fieldValues, noteTypeId, tags. Field keys are sorted. */
export function canonicalNoteDocument(doc: NoteDocument): string {
  const fieldValues: FieldValues = {};
  for (const key of Object.keys(doc.fieldValues).sort()) fieldValues[key] = doc.fieldValues[key] ?? '';
  return JSON.stringify({
    acceptedAnswers: doc.acceptedAnswers,
    fieldValues,
    noteTypeId: doc.noteTypeId,
    tags: doc.tags,
  });
}

export function noteDocumentBytes(doc: NoteDocument): number {
  return Buffer.byteLength(canonicalNoteDocument(doc), 'utf8');
}

export function sameNoteDocument(left: NoteDocument, right: NoteDocument): boolean {
  return canonicalNoteDocument(left) === canonicalNoteDocument(right);
}

function sameFieldValues(left: FieldValues, right: FieldValues): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

export async function withUserRevisionLock(tx: Pick<RevisionTx, 'execute'>, userId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 941))`);
}

function documentOf(note: LockedNoteDocument): NoteDocument {
  return {
    acceptedAnswers: note.acceptedAnswers,
    fieldValues: note.fieldValues,
    noteTypeId: note.noteTypeId,
    tags: note.tags,
  };
}

async function capturePreImage(tx: RevisionTx, note: LockedNoteDocument) {
  const preImage = documentOf(note);
  const canonical = canonicalNoteDocument(preImage);
  if (Buffer.byteLength(canonical, 'utf8') > NOTE_REVISION_MAX_BYTES) return;
  const [newest] = await tx.select({
    acceptedAnswers: noteRevisions.acceptedAnswers,
    fieldValues: noteRevisions.fieldValues,
    noteTypeId: noteRevisions.noteTypeId,
    tags: noteRevisions.tags,
  }).from(noteRevisions).where(eq(noteRevisions.noteId, note.id))
    .orderBy(desc(noteRevisions.revisedAt), desc(noteRevisions.id)).limit(1);
  if (newest && canonicalNoteDocument(newest) === canonical) return;
  await tx.insert(noteRevisions).values({
    userId: note.userId,
    noteId: note.id,
    noteTypeId: note.noteTypeId,
    fieldValues: note.fieldValues,
    tags: note.tags,
    acceptedAnswers: note.acceptedAnswers,
    revisedAt: note.updatedAt,
  });
  // Keep the five newest for the note, then the thousand newest for the user.
  await tx.execute(sql`
    DELETE FROM note_revisions
    WHERE id IN (
      SELECT id FROM note_revisions
      WHERE note_id = ${note.id}
      ORDER BY revised_at DESC, id DESC
      OFFSET ${NOTE_REVISIONS_PER_NOTE}
    )
  `);
  await tx.execute(sql`
    DELETE FROM note_revisions
    WHERE id IN (
      SELECT id FROM note_revisions
      WHERE user_id = ${note.userId}
      ORDER BY created_at DESC, id DESC
      OFFSET ${NOTE_REVISIONS_PER_USER}
    )
  `);
}

/** Records a pre-image when fields or tags change, then updates only the columns in `patch`. Does not touch cards. */
export async function writeNoteDocument(tx: RevisionTx, note: LockedNoteDocument, patch: NoteDocumentPatch) {
  const fieldsChanged = patch.fieldValues !== undefined && !sameFieldValues(note.fieldValues, patch.fieldValues);
  const tagsChanged = patch.tags !== undefined && !sameTags(note.tags, patch.tags);
  if (fieldsChanged || tagsChanged) await capturePreImage(tx, note);
  const next: {
    updatedAt: Date;
    fieldValues?: FieldValues;
    tags?: string[];
    acceptedAnswers?: string[];
    noteTypeId?: string;
  } = { updatedAt: patch.updatedAt };
  if (patch.fieldValues !== undefined) next.fieldValues = patch.fieldValues;
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.acceptedAnswers !== undefined) next.acceptedAnswers = patch.acceptedAnswers;
  if (patch.noteTypeId !== undefined) next.noteTypeId = patch.noteTypeId;
  const [updated] = await tx.update(notes).set(next)
    .where(and(eq(notes.id, note.id), eq(notes.userId, note.userId))).returning();
  if (!updated) throw new Error('note_missing');
  return updated;
}

function clipLabel(text: string): string {
  const max = 160;
  if (text.length <= max) return text;
  const tail = text.charCodeAt(max - 1);
  const end = tail >= 0xd800 && tail <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

function revisionLabel(fieldValues: FieldValues, fields: NoteField[]): string {
  const ordered = [...fields].sort((left, right) => left.ord - right.ord);
  let source: string | undefined;
  for (const field of ordered) {
    const value = fieldValues[field.name];
    if (typeof value === 'string') {
      source = value;
      break;
    }
  }
  if (source === undefined) {
    const fallback = Object.values(fieldValues).find((value) => typeof value === 'string');
    source = typeof fallback === 'string' ? fallback : '';
  }
  return clipLabel(fieldPlainText(source).replace(/\s+/g, ' ').trim());
}

export async function listNoteRevisions(userId: string, noteId: string) {
  const [note] = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId))).limit(1);
  if (!note) return null;
  const rows = await db.select({
    id: noteRevisions.id,
    revisedAt: noteRevisions.revisedAt,
    noteTypeId: noteRevisions.noteTypeId,
    fieldValues: noteRevisions.fieldValues,
  }).from(noteRevisions)
    .where(and(eq(noteRevisions.noteId, noteId), eq(noteRevisions.userId, userId)))
    .orderBy(desc(noteRevisions.revisedAt), desc(noteRevisions.id))
    .limit(NOTE_REVISIONS_PER_NOTE);
  const typeIds = [...new Set(rows.map((row) => row.noteTypeId))];
  const types = typeIds.length === 0 ? [] : await db.select({ id: noteTypes.id, fields: noteTypes.fields })
    .from(noteTypes).where(inArray(noteTypes.id, typeIds));
  const fieldsByType = new Map(types.map((type) => [type.id, type.fields]));
  return rows.map((row) => ({
    id: row.id,
    revisedAt: row.revisedAt,
    noteTypeId: row.noteTypeId,
    label: revisionLabel(row.fieldValues, fieldsByType.get(row.noteTypeId) ?? []),
  }));
}

export async function readNoteRevision(tx: Pick<RevisionTx, 'select'>, userId: string, noteId: string, revisionId: string) {
  const [row] = await tx.select().from(noteRevisions).where(and(
    eq(noteRevisions.id, revisionId),
    eq(noteRevisions.noteId, noteId),
    eq(noteRevisions.userId, userId),
  )).limit(1);
  return row ?? null;
}
