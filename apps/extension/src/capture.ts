import { extractPage } from './extract';
import type { CaptureResult } from './types';
declare global { interface Window { __reomiCapture?: CaptureResult } }
try { window.__reomiCapture = extractPage(document, window); }
catch { window.__reomiCapture = { ok: false, error: 'unreadable' }; }
