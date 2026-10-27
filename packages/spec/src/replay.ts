/**
 * Remembers which signed messages it has seen, so a replayed one is refused. Readers check
 * whether a key is recorded before they act, and record it only after every other check passes
 * and any signing is done, so a refused request never uses up an approval.
 */
export interface ReplayGuard {
  /** True when the key is already recorded. */
  isRecorded(key: string): Promise<boolean>
  /** Records every key, or none of them if any is already recorded. True when all were new. */
  recordAll(entries: readonly { key: string; expiry: bigint }[]): Promise<boolean>
}

/**
 * A replay guard in memory, for tests and a single process. Production stores keys in the
 * database with a unique index and records a set in one transaction, so two workers can't both
 * record one.
 */
export class MemoryReplayGuard implements ReplayGuard {
  readonly #seen = new Map<string, bigint>()

  async isRecorded(key: string): Promise<boolean> {
    return this.#seen.has(key)
  }

  async recordAll(entries: readonly { key: string; expiry: bigint }[]): Promise<boolean> {
    const keys = entries.map((e) => e.key)
    if (new Set(keys).size !== keys.length || keys.some((k) => this.#seen.has(k))) return false
    for (const e of entries) this.#seen.set(e.key, e.expiry)
    return true
  }

  /** Forgets keys whose messages have expired, which readers refuse on expiry anyway. */
  prune(now: bigint): void {
    for (const [key, expiry] of this.#seen) {
      if (expiry <= now) this.#seen.delete(key)
    }
  }
}
