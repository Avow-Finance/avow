import { MODERATO_RPC_URL } from '@avow-finance/sdk'
import { type Address, getAddress, isAddress } from 'viem'

export interface SupplierSettings {
  /** Avow's API, an origin such as `https://api.testnet.avow.finance`. */
  apiUrl: string
  rpcUrl: string
  /** Avow's lock factory. A booking counts only on a lock it made. */
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
}

const address = (env: Record<string, string | undefined>, name: string, missing: string[]) => {
  const value = env[name]?.trim() ?? ''
  if (!isAddress(value, { strict: false })) {
    missing.push(name)
    return '0x0000000000000000000000000000000000000000' as Address
  }
  return getAddress(value)
}

const whole = (value: string | undefined, fallback: number) => {
  const n = value === undefined || value === '' ? fallback : Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** The state directory and RPC, which every command needs. */
export function baseSettings(env: Record<string, string | undefined>) {
  return {
    stateDir: env.STATE_DIR?.trim() || '.avow-supplier',
    rpcUrl: env.RPC_URL?.trim() || MODERATO_RPC_URL,
  }
}

/** Every setting `serve` needs. It throws naming each one that's missing or wrong. */
export function serveSettings(env: Record<string, string | undefined>): SupplierSettings {
  const missing: string[] = []
  const apiUrl = env.AVOW_API_URL?.trim() ?? ''
  if (!/^https?:\/\/[^/]+$/.test(apiUrl)) missing.push('AVOW_API_URL')
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
  if (missing.length > 0) {
    throw new Error(`These settings are missing or wrong: ${missing.sort().join(', ')}`)
  }
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
  }
}
