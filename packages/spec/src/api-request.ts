import { type Address, type Hex, keccak256, toHex } from 'viem'
import {
  type ApiRequest,
  type AvowDomain,
  apiRequestTypedData,
  digestOf,
  type Signed,
} from './eip712.js'
import type { ReasonCode } from './reasons.js'
import { MESSAGE_VERSIONS } from './version.js'

/** The scheme name a signed request puts in its Authorization header. */
export const API_AUTH_SCHEME = 'Avow'

/** The longest a signed request may stay valid, in seconds from when Avow receives it. */
export const API_REQUEST_MAX_VALIDITY = 300n

/** The largest body a signed request may carry, in bytes. */
export const API_BODY_MAX_BYTES = 65_536

/** The methods a signed request may use. A GET carries no body. */
export const API_METHODS = ['GET', 'POST'] as const

/**
 * The paths a signed request may name: `/v1` and one or more segments of lower-case letters,
 * digits, `-` and `_`. No query, no trailing slash, no dot segments and no percent-encoding, so the
 * path a client signs is the path a server reads, whatever either side's URL parser does.
 */
export const API_PATH_PATTERN = /^\/v1(\/[a-z0-9_-]+)+$/

/** A deployment's audience: an http or https origin in lower case, with no path or trailing slash. */
export const API_AUDIENCE_PATTERN = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/

/**
 * A key that signs requests to Avow's API with its bare signature, the way the lock reads a
 * signing key's: secp256k1, P-256 or WebAuthn, outside any keychain envelope.
 */
export interface RequestKey {
  /** The key's own address, which Avow knows as an enrolled agent key or a supplier's signing key. */
  readonly address: Address
  signDigest(digest: Hex): Promise<Hex>
}

/** keccak256 of a request body's exact bytes. A request with no body hashes no bytes. */
export function apiBodyHash(body: Uint8Array): Hex {
  return keccak256(body)
}

/** A fresh request id, 32 random bytes. */
export function newRequestId(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Why a request can't be signed or checked as it stands, or null when it can. Both the client and
 * the API run this, so neither signs or verifies a request the other would read differently.
 */
export function apiRequestProblem(r: {
  audience: string
  method: string
  path: string
  body: Uint8Array
}): ReasonCode | null {
  if (!API_AUDIENCE_PATTERN.test(r.audience)) return 'request.invalid'
  if (!(API_METHODS as readonly string[]).includes(r.method)) return 'request.invalid'
  if (!API_PATH_PATTERN.test(r.path)) return 'request.invalid'
  if (r.body.length > API_BODY_MAX_BYTES) return 'request.invalid'
  if (r.method === 'GET' && r.body.length > 0) return 'request.invalid'
  return null
}

/**
 * What a signed request's Authorization header carries. The API rebuilds the rest of the signed
 * message from the request it received: its own audience, the method, the path and the body's hash.
 */
export interface ApiCredentials {
  signer: Address
  /** The lock whose domain the request was signed under. */
  lock: Address
  requestId: Hex
  expiry: bigint
  signature: Hex
}

export function formatApiAuthorization(c: ApiCredentials): string {
  return `${API_AUTH_SCHEME} signer=${c.signer}, lock=${c.lock}, requestId=${c.requestId}, expiry=${c.expiry}, signature=${c.signature}`
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const SIGNATURE = /^0x([0-9a-fA-F]{2})+$/
const FIELDS = ['signer', 'lock', 'requestId', 'expiry', 'signature'] as const

/**
 * Reads a signed request's Authorization header, or returns null when it isn't one. The fields are
 * separated by a comma and one space, each appears once and nothing else may, so two readers can't
 * take different values from one header. Hex comes back in lower case.
 */
export function parseApiAuthorization(header: string | null | undefined): ApiCredentials | null {
  if (!header?.startsWith(`${API_AUTH_SCHEME} `)) return null
  const fields = new Map<string, string>()
  for (const part of header.slice(API_AUTH_SCHEME.length + 1).split(', ')) {
    const eq = part.indexOf('=')
    if (eq < 1) return null
    const name = part.slice(0, eq)
    if (!(FIELDS as readonly string[]).includes(name) || fields.has(name)) return null
    fields.set(name, part.slice(eq + 1))
  }
  const signer = fields.get('signer')
  const lock = fields.get('lock')
  const requestId = fields.get('requestId')
  const expiry = fields.get('expiry')
  const signature = fields.get('signature')
  if (signer === undefined || !ADDRESS.test(signer)) return null
  if (lock === undefined || !ADDRESS.test(lock)) return null
  if (requestId === undefined || !BYTES32.test(requestId)) return null
  if (expiry === undefined || !DECIMAL.test(expiry) || BigInt(expiry) >= 2n ** 64n) return null
  if (signature === undefined || !SIGNATURE.test(signature)) return null
  return {
    signer: signer.toLowerCase() as Address,
    lock: lock.toLowerCase() as Address,
    requestId: requestId.toLowerCase() as Hex,
    expiry: BigInt(expiry),
    signature: signature.toLowerCase() as Hex,
  }
}

/** The request as the API rebuilds it from what it received, ready to check against the signature. */
export function apiRequestOf(args: {
  audience: string
  method: string
  path: string
  body: Uint8Array
  credentials: ApiCredentials
}): ApiRequest {
  return {
    audience: args.audience,
    method: args.method,
    path: args.path,
    bodyHash: apiBodyHash(args.body),
    signer: args.credentials.signer,
    requestId: args.credentials.requestId,
    expiry: args.credentials.expiry,
  }
}

/**
 * Signs one request to Avow's API. It returns the Authorization header to send with exactly these
 * body bytes, and the signed request, the record of what the client asked. It throws for a request
 * `apiRequestProblem` refuses, since the API would refuse it too.
 */
export async function signApiRequest(args: {
  key: RequestKey
  domain: AvowDomain
  audience: string
  method: string
  path: string
  body: Uint8Array
  requestId: Hex
  expiry: bigint
}): Promise<{ authorization: string; request: Signed<ApiRequest> }> {
  const problem = apiRequestProblem(args)
  if (problem) throw new Error(`The request can't be signed as it stands (${problem})`)
  if (!BYTES32.test(args.requestId)) throw new Error('The request id has to be 32 bytes of hex')
  const message: ApiRequest = {
    audience: args.audience,
    method: args.method,
    path: args.path,
    bodyHash: apiBodyHash(args.body),
    signer: args.key.address,
    requestId: args.requestId.toLowerCase() as Hex,
    expiry: args.expiry,
  }
  const signature = await args.key.signDigest(digestOf(apiRequestTypedData(message, args.domain)))
  return {
    authorization: formatApiAuthorization({
      signer: args.key.address,
      lock: args.domain.verifyingContract,
      requestId: message.requestId,
      expiry: args.expiry,
      signature,
    }),
    request: {
      type: 'ApiRequest',
      schemaVersion: MESSAGE_VERSIONS.ApiRequest,
      chainId: args.domain.chainId,
      lock: args.domain.verifyingContract,
      message,
      signature,
    },
  }
}
