import type { Captured, CaptureResult } from './types';

/** A content-script result is usable only while its originating tab is still
 * on that exact page. Read the URL again after both asynchronous injections. */
export async function captureStablePage(originalUrl: string, extract: () => Promise<CaptureResult | undefined>, currentUrl: () => Promise<string | undefined>): Promise<Captured> {
  if (!/^https?:\/\//.test(originalUrl)) throw new Error('unsupported');
  const result = await extract();
  if (!result?.ok) throw new Error(result?.error ?? 'unreadable');
  if (await currentUrl() !== originalUrl || result.capture.url !== originalUrl) throw new Error('changed_page');
  return result.capture;
}
