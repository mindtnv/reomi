import { and, eq, inArray, or } from 'drizzle-orm';
import { sources } from '@reomi/db';

export { isSourceTextReadable } from '@reomi/shared';
export const sourceTextReadableWhere = () => or(inArray(sources.status, ['ready', 'indexing']),
  and(eq(sources.status, 'error'), eq(sources.errorCode, 'index_failed')))!;
