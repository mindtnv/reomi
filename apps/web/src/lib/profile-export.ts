import { api, ok } from './api';

export const PROFILE_EXPORT_FILENAME = 'reomi-export.json';

/** The file is exactly the payload returned for the signed-in owner. */
export function profileExportFile(data: unknown): { filename: string; body: string } {
  return { filename: PROFILE_EXPORT_FILENAME, body: JSON.stringify(data, null, 2) };
}

/** Existing account JSON export, shared by settings and destructive previews. */
export async function downloadProfileExport(isCurrent: () => boolean = () => true): Promise<boolean> {
  const data = await ok(await (api as any).profile.export.get());
  if (!isCurrent()) return false;
  const file = profileExportFile(data);
  const url = URL.createObjectURL(new Blob([file.body], { type: 'application/json' }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
  } finally { URL.revokeObjectURL(url); }
  return true;
}
