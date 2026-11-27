import { isIP } from 'node:net'
import { MODERATO_RPC_URL } from '@avow-finance/sdk'
import { TEMPO_MODERATO } from '@avow-finance/spec'
import { type Address, getAddress, type Hex, isAddress } from 'viem'
import { isWebhookSecret } from './signature.js'
import type { WebhookTarget } from './webhook.js'

export interface SupplierSettings {
  /** Avow's API, an origin such as `https://api.testnet.avow.finance`. */
  apiUrl: string
  rpcUrl: string
  /**
   * Avow's current lock factory. When the SDK trusts it, a booking counts on a lock from any factory
   * the SDK trusts, so buyers keep their locks when the sandbox moves to a newer one.
   */
  factory: Address
  /** The token reserves are held in. */
  token: Address
  /** The keys Avow signs its authorizations and approvals with. */
  approvalKeys: Address[]
  /** The business id Avow recorded for this supplier. */
  businessId: string
  port: number
  stateDir: string
  /** The largest reserve this supplier takes for one booking, in micros. */
  maxReserve: bigint
  pollSeconds: number
  /** How many open bookings it holds for one buyer's lock. */
  maxOpenPerBuyer: number
  /** How many open bookings it holds in all. */
  maxOpenBookings: number
  /** Where the webhook posts events and the secret it signs them with, or null for no webhook. */
  webhook: WebhookTarget | null
  /** Where the supplier's own systems reach the local check. */
  localHost: string
  localPort: number
}

/**
 * The keys a host passes in its environment from a secret store: the signing key, and only the
 * account's address. The account key stays wherever `init` left it, since `serve` never signs
 * with it.
 */
export interface EnvKeys {
  signingKey: Hex
  account: Address
}

const address = (env: Record<string, string | undefined>, name: string, missing: string[]) => {
  const value = env[name]?.trim() ?? ''
  if (!isAddress(value, { strict: false })) {
    missing.push(name)
    return '0x0000000000000000000000000000000000000000' as Address
  }
  return getAddress(value)
}

/** Throws naming every setting that's missing or wrong, when any is. */
function refuseMissing(missing: string[]) {
  if (missing.length > 0) {
    throw new Error(
      `These settings are missing or wrong: ${missing.sort().join(', ')}. The README lists each one and where it comes from. Set them in this terminal.`,
    )
  }
}

const whole = (value: string | undefined, fallback: number) => {
  const n = value === undefined || value === '' ? fallback : Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Avow's API, an origin with no path, or the name pushed onto `missing` when it's wrong. */
function apiUrlOf(env: Record<string, string | undefined>, missing: string[]): string {
  const apiUrl = env.AVOW_API_URL?.trim() ?? ''
  if (!/^https?:\/\/[^/]+$/.test(apiUrl)) missing.push('AVOW_API_URL')
  return apiUrl
}

/**
 * Where `init` registers the supplier: Avow's API and factory when both settings are set, or null
 * when either is left out, so `init` reads the testnet's published deployment instead. A buyer's
 * terminal often sets `AVOW_FACTORY` alone, and that leaves the published deployment in charge.
 */
export function registrationSettings(
  env: Record<string, string | undefined>,
): { chainId: number; apiUrl: string; factory: Address } | null {
  const set = (name: string) => (env[name]?.trim() ?? '') !== ''
  if (!set('AVOW_API_URL') || !set('AVOW_FACTORY')) return null
  const missing: string[] = []
  const apiUrl = apiUrlOf(env, missing)
  const factory = address(env, 'AVOW_FACTORY', missing)
  refuseMissing(missing)
  return { chainId: TEMPO_MODERATO, apiUrl, factory }
}

/** The state directory and RPC, which every command needs. */
export function baseSettings(env: Record<string, string | undefined>) {
  return {
    stateDir: env.STATE_DIR?.trim() || '.avow-supplier',
    rpcUrl: env.RPC_URL?.trim() || MODERATO_RPC_URL,
  }
}

/** What `report` needs: Avow's factory, so a lock counts only if it made it, and the token. */
export function reportSettings(env: Record<string, string | undefined>) {
  const missing: string[] = []
  const factory = address(env, 'AVOW_FACTORY', missing)
  const token = address(env, 'AVOW_TOKEN', missing)
  refuseMissing(missing)
  return { ...baseSettings(env), factory, token }
}

/** Every setting `serve` needs. It throws naming each one that's missing or wrong. */
export function serveSettings(env: Record<string, string | undefined>): SupplierSettings {
  const missing: string[] = []
  const apiUrl = apiUrlOf(env, missing)
  const factory = address(env, 'AVOW_FACTORY', missing)
  const token = address(env, 'AVOW_TOKEN', missing)
  const approvalKeys = (env.AVOW_APPROVAL_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')
  if (approvalKeys.length === 0 || !approvalKeys.every((k) => isAddress(k, { strict: false }))) {
    missing.push('AVOW_APPROVAL_KEYS')
  }
  const businessId = env.SUPPLIER_BUSINESS_ID?.trim() ?? ''
  if (!/^[a-z0-9_-]{1,64}$/.test(businessId)) missing.push('SUPPLIER_BUSINESS_ID')
  const port = whole(env.PORT, 8790)
  if (port === null || port > 65_535) missing.push('PORT')
  const maxReserve = whole(env.MAX_RESERVE_DOLLARS, 1000)
  if (maxReserve === null) missing.push('MAX_RESERVE_DOLLARS')
  const pollSeconds = whole(env.POLL_SECONDS, 5)
  if (pollSeconds === null) missing.push('POLL_SECONDS')
  const maxOpenPerBuyer = whole(env.MAX_OPEN_PER_BUYER, 5)
  if (maxOpenPerBuyer === null) missing.push('MAX_OPEN_PER_BUYER')
  const maxOpenBookings = whole(env.MAX_OPEN_BOOKINGS, 200)
  if (maxOpenBookings === null) missing.push('MAX_OPEN_BOOKINGS')
  const webhook = webhookSettings(env, missing)
  const localPort = whole(env.LOCAL_PORT, 8791)
  if (localPort === null || localPort > 65_535 || localPort === port) missing.push('LOCAL_PORT')
  const localHost = env.LOCAL_HOST?.trim() || '127.0.0.1'
  if (localHost !== 'localhost' && isIP(localHost) === 0) missing.push('LOCAL_HOST')
  refuseMissing(missing)
  return {
    ...baseSettings(env),
    apiUrl,
    factory,
    token,
    approvalKeys: approvalKeys.map((k) => getAddress(k)),
    businessId,
    port: port as number,
    maxReserve: BigInt(maxReserve as number) * 1_000_000n,
    pollSeconds: pollSeconds as number,
    maxOpenPerBuyer: maxOpenPerBuyer as number,
    maxOpenBookings: maxOpenBookings as number,
    webhook,
    localHost,
    localPort: localPort as number,
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The webhook, when `WEBHOOK_URL` is set. Its URL is https, or http to this machine for a receiver
 * running beside the adapter, with no user name or password in it, and `WEBHOOK_SECRET` has to be
 * a secret `avow-supplier secret` made.
 * Neither value appears in an error, since the secret is the receiver's only proof of who posted.
 */
function webhookSettings(
  env: Record<string, string | undefined>,
  missing: string[],
): WebhookTarget | null {
  const url = env.WEBHOOK_URL?.trim() ?? ''
  const secret = env.WEBHOOK_SECRET?.trim() ?? ''
  if (url === '') {
    if (secret !== '') missing.push('WEBHOOK_URL')
    return null
  }
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  const allowed =
    parsed !== null &&
    parsed.username === '' &&
    parsed.password === '' &&
    (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)))
  if (!allowed) missing.push('WEBHOOK_URL')
  if (!isWebhookSecret(secret)) missing.push('WEBHOOK_SECRET')
  return { url, secret }
}

/**
 * The keys in the environment, or null when it holds none, so the commands use the state
 * directory's keys file. `SUPPLIER_SIGNING_KEY` and `SUPPLIER_ACCOUNT` go together, and it throws
 * naming the one that's missing or wrong when only one is right.
 */
export function envKeys(env: Record<string, string | undefined>): EnvKeys | null {
  const signingKey = env.SUPPLIER_SIGNING_KEY?.trim() ?? ''
  const account = env.SUPPLIER_ACCOUNT?.trim() ?? ''
  if (signingKey === '' && account === '') return null
  const missing: string[] = []
  if (!/^0x[0-9a-fA-F]{64}$/.test(signingKey)) missing.push('SUPPLIER_SIGNING_KEY')
  if (!isAddress(account, { strict: false })) missing.push('SUPPLIER_ACCOUNT')
  if (missing.length > 0) {
    throw new Error(
      `These settings are missing or wrong: ${missing.join(', ')}. Set both SUPPLIER_SIGNING_KEY and SUPPLIER_ACCOUNT to take the keys from the environment, or neither to use the keys file.`,
    )
  }
  return { signingKey: signingKey.toLowerCase() as Hex, account: getAddress(account) }
}
