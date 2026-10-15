import { MAX_ASSISTANT_CONCURRENT_TURNS } from '@reomi/shared';

export type TurnAdmissionResult =
  | { ok: true; controller: AbortController }
  | { ok: false; error: 'turn_in_progress' | 'too_many_active_turns' };

/** Single API instance, like the existing cooldowns. Multi-instance needs shared admission. */
export class TurnAdmission {
  private turns = new Map<string, { userId: string; controller: AbortController }>();

  acquire(userId: string, conversationId: string): TurnAdmissionResult {
    // Abort requests cancellation; only settlement releases ownership. Expiring
    // an active entry by age could admit a second writer to the same transcript.
    if (this.turns.has(conversationId)) return { ok: false, error: 'turn_in_progress' };
    let active = 0;
    for (const turn of this.turns.values()) if (turn.userId === userId) active++;
    if (active >= MAX_ASSISTANT_CONCURRENT_TURNS) return { ok: false, error: 'too_many_active_turns' };
    const controller = new AbortController();
    this.turns.set(conversationId, { userId, controller });
    return { ok: true, controller };
  }

  release(conversationId: string, controller: AbortController): void {
    if (this.turns.get(conversationId)?.controller === controller) this.turns.delete(conversationId);
  }
}

export const turnAdmission = new TurnAdmission();
