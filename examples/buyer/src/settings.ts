import { type Address, getAddress, isAddress } from 'viem'

/** Moderato, Tempo's testnet, where every Avow deployment so far runs. */
export const MODERATO_RPC = 'https://rpc.moderato.tempo.xyz'
/** AlphaUSD, which pays Moderato's fees and comes from its faucet. */
export const ALPHA_USD: Address = '0x20C0000000000000000000000000000000000001'

type Env = Record<string, string | undefined>

/** Reads settings by name, collecting every one that's missing or wrong. */
class Reader {
  readonly missing: string[] = []

  constructor(private readonly env: Env) {}

  text(name: string, pattern: RegExp, fallback?: string): string {
    const value = this.env[name]?.trim() || fallback || ''
    if (!pattern.test(value)) this.missing.push(name)
    return value
  }

  address(name: string): Address {
    const value = this.env[name]?.trim() ?? ''
    if (!isAddress(value, { strict: false })) {
      this.missing.push(name)
      return '0x0000000000000000000000000000000000000000'
    }
    return getAddress(value)
  }

  whole(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
    const raw = this.env[name]?.trim()
    const n = raw ? Number(raw) : fallback
    if (!Number.isSafeInteger(n) || n < 0 || n > max) this.missing.push(name)
    return n
  }

  done() {
    if (this.missing.length > 0) {
      throw new Error(`These settings are missing or wrong: ${[...this.missing].sort().join(', ')}`)
    }
  }
}

const ORIGIN = /^https?:\/\/[^/]+$/
const ID = /^[a-z0-9_-]{1,64}$/

export function baseSettings(env: Env) {
  return {
    stateDir: env.STATE_DIR?.trim() || '.avow-buyer',
    rpcUrl: env.RPC_URL?.trim() || MODERATO_RPC,
  }
}

/** What `init` needs: where Avow's factory is. */
export function initSettings(env: Env) {
  const r = new Reader(env)
  const factory = r.address('AVOW_FACTORY')
  r.done()
  return { ...baseSettings(env), factory }
}

/** What `enroll` needs: Avow's API, the business as Avow recorded it, the supplier and the limits. */
export function enrollSettings(env: Env) {
  const r = new Reader(env)
  const settings = {
    ...baseSettings(env),
    apiUrl: r.text('AVOW_API_URL', ORIGIN),
    businessId: r.text('BUYER_BUSINESS_ID', ID),
    agentId: r.text('AGENT_ID', ID, 'agt_quickstart'),
    supplierUrl: r.text('SUPPLIER_URL', /^https?:\/\/\S+$/),
    token: r.address('AVOW_TOKEN'),
    reserve: BigInt(r.whole('RESERVE_DOLLARS', 500, 100_000)) * 1_000_000n,
    open: BigInt(r.whole('OPEN_BOOKINGS', 3, 100)),
  }
  r.done()
  return settings
}

/** What `book` needs: Avow's API and dispute settings, the supplier and the booking's window. */
export function bookSettings(env: Env) {
  const r = new Reader(env)
  const settings = {
    ...baseSettings(env),
    apiUrl: r.text('AVOW_API_URL', ORIGIN),
    supplierUrl: r.text('SUPPLIER_URL', /^https?:\/\/\S+$/),
    token: r.address('AVOW_TOKEN'),
    arbiter: r.address('AVOW_ARBITER'),
    day90SupplierShareBps: r.whole('AVOW_DAY90_SHARE_BPS', 5000, 10_000),
    reserve: BigInt(r.whole('RESERVE_DOLLARS', 500, 100_000)) * 1_000_000n,
    startsIn: BigInt(r.whole('WINDOW_STARTS_IN', 720)),
    minutes: BigInt(r.whole('WINDOW_MINUTES', 30)),
  }
  r.done()
  return settings
}
