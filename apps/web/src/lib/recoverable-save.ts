import { newUuidV7, type UiActionResult } from '@reomi/shared';

export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'uncertain' | 'conflict';
export interface PendingSave<T> { owner: string; requestId: string; payload: T; fingerprint: string }
export interface SaveSnapshot<T> { status: SaveStatus; pending: PendingSave<T> | null; error: string | null; errorStatus?: number }

/** Tracks a submitted revision, never owns or replaces the editor's live buffer. */
export class RecoverableSave<T> {
  private snapshot: SaveSnapshot<T> = { status: 'clean', pending: null, error: null };
  private listeners = new Set<() => void>();
  private fingerprint = '';
  private baseline = '';
  private alive = true;
  private busy = false;
  constructor(readonly owner: string) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: Partial<SaveSnapshot<T>>) {
    if (!this.alive) return;
    this.snapshot = { ...this.snapshot, ...value }; for (const listener of this.listeners) listener();
  }
  edit = (fingerprint: string) => {
    if (this.fingerprint === fingerprint) return;
    this.fingerprint = fingerprint;
    if (this.snapshot.status === 'saving' || this.snapshot.status === 'uncertain' || this.snapshot.status === 'conflict') return;
    this.publish({ status: fingerprint === this.baseline ? 'clean' : 'dirty', error: null });
  };
  reset = (fingerprint: string) => {
    this.baseline = fingerprint; this.fingerprint = fingerprint;
    this.publish({ status: 'clean', pending: null, error: null });
  };
  restorePending = (request: PendingSave<T>) => {
    if (request.owner !== this.owner || !request.requestId || !request.payload) return;
    this.publish({ status: 'uncertain', pending: request, error: null });
  };
  resolveConflict = () => { if (!this.busy) this.publish({ status: 'dirty', pending: null, error: null }); };
  canonicalizeAcknowledgement = (submitted: string, canonical: string) => {
    if (this.baseline !== submitted || this.snapshot.pending) return;
    this.baseline = canonical;
    if (this.fingerprint === submitted) this.fingerprint = canonical;
    this.publish({ status: this.fingerprint === canonical ? 'saved' : 'dirty' });
  };

  async run(payload: T, fingerprint: string,
    execute: (request: PendingSave<T>) => Promise<UiActionResult>, reconcile: (requestId: string) => Promise<UiActionResult>,
  ): Promise<{ response: UiActionResult; submitted: PendingSave<T>; currentMatches: boolean } | null> {
    if (!this.alive || this.busy || this.snapshot.status === 'conflict') return null;
    this.fingerprint = fingerprint;
    const original = this.snapshot.status === 'uncertain' ? this.snapshot.pending : null;
    const submitted = original ?? { owner: this.owner, requestId: newUuidV7(), payload: structuredClone(payload), fingerprint };
    this.busy = true;
    let executing = !original;
    this.publish({ status: 'saving', pending: submitted, error: null, errorStatus: undefined });
    try {
      let response: UiActionResult;
      if (original) {
        try { response = await reconcile(original.requestId); }
        catch (error) {
          if ((error as { status?: number }).status !== 404 || (error as { safeMessage?: string }).safeMessage !== 'receipt_not_found') throw error;
          executing = true;
          response = await execute(original);
        }
      } else response = await execute(submitted);
      if (!this.alive) return null;
      const currentMatches = this.fingerprint === submitted.fingerprint;
      this.baseline = submitted.fingerprint;
      const conflict = response.outcome !== 'applied';
      this.publish({ pending: null, status: conflict ? 'conflict' : currentMatches ? 'saved' : 'dirty',
        error: conflict ? response.outcome : null, errorStatus: conflict ? 409 : undefined });
      return { response, submitted, currentMatches: currentMatches && !conflict };
    } catch (error) {
      if (!this.alive) return null;
      const status = (error as { status?: number }).status ?? 0;
      const code = typeof (error as { safeMessage?: string }).safeMessage === 'string' ? (error as { safeMessage: string }).safeMessage : 'save_failed';
      const expiredUncertainty = Boolean(original && code === 'request_expired');
      const lostAuthentication = Boolean(original && (status === 401 || status === 403));
      const knownFailure = executing && status >= 400 && status < 500 && !lostAuthentication;
      // Expiry says the old receipt is no longer available, not that the old
      // create never committed. Keep its identity in the persisted draft.
      this.publish({ status: knownFailure && status === 409 ? 'conflict' : knownFailure ? 'failed' : 'uncertain',
        errorStatus: status,
        pending: knownFailure && !expiredUncertainty ? null : submitted,
        error: code });
      return null;
    } finally { this.busy = false; }
  }
  activate = () => { this.alive = true; };
  dispose = () => { this.alive = false; this.listeners.clear(); };
}
