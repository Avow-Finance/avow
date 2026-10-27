/**
 * Remembers which signed messages it has seen, so a replayed one is refused (acceptance test 4).
 * Readers check a message's expiry first and record its key last, after every other check passes,
 * so a refused message never uses up its nonce.
 */
export interface ReplayGuard {
  /** Records a key. True the first time, false every time after. */
  recordOnce(key: string, expiry: bigint): Promise<boolean>
}

/**
 * A replay guard in memory, for tests and a single process. Production stores keys in the
 * database with a unique index, so two workers can't both record one.
 */
export class MemoryReplayGuard implements ReplayGuard {
  readonly #seen = new Map<string, bigint>()

  async recordOnce(key: string, expiry: bigint): Promise<boolean> {
    if (this.#seen.has(key)) return false
    this.#seen.set(key, expiry)
    return true
  }

  /** Forgets keys whose messages have expired, which readers refuse on expiry anyway. */
  prune(now: bigint): void {
    for (const [key, expiry] of this.#seen) {
      if (expiry <= now) this.#seen.delete(key)
    }
  }
}
