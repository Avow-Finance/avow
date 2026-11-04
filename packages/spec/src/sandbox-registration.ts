import {
  type Address,
  getAddress,
  type Hex,
  hashTypedData,
  isAddressEqual,
  toHex,
  zeroAddress,
} from 'viem'
import { z } from 'zod'
import type { HashSigner } from './keychain.js'
import type { Parsed } from './wire.js'

/**
 * The registrations a sandbox business or supplier signs, defined once for Avow's API that checks
 * them and the SDK that signs them. A business registers at `SANDBOX_PATHS.businesses` and a
 * supplier at `SANDBOX_PATHS.suppliers`.
 */

/**
 * The environment every sandbox registration names, so a signature made for it can never stand
 * for a registration anywhere else.
 */
export const SANDBOX_ENVIRONMENT = 'sandbox'

/**
 * The EIP-712 domain every sandbox registration is signed under. Its name is its own, apart from
 * the `Avow` domain every other message Avow and its locks read is signed under, so no signature
 * on a registration can stand for another message, and none on another message for a
 * registration. It names this chain and the lock factory, the one contract the sandbox serves.
 */
export const registrationDomain = (chainId: number, factory: Address) =>
  ({
    name: 'Avow sandbox registration',
    version: '1',
    chainId,
    verifyingContract: factory,
  }) as const

export const REGISTRATION_TYPES = {
  BusinessRegistration: [
    { name: 'environment', type: 'string' },
    { name: 'audience', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'lock', type: 'address' },
    { name: 'legalName', type: 'string' },
    { name: 'country', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
  SupplierRegistration: [
    { name: 'environment', type: 'string' },
    { name: 'audience', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'signingKey', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

/** What a business's account signs to register it in the sandbox. */
export interface BusinessRegistration {
  environment: typeof SANDBOX_ENVIRONMENT
  audience: string
  account: Address
  lock: Address
  legalName: string
  country: string
  nonce: Hex
  /** Unix seconds after which Avow won't take it. */
  expiry: bigint
}

/** What a supplier's account and its signing key both sign to register it in the sandbox. */
export interface SupplierRegistration {
  environment: typeof SANDBOX_ENVIRONMENT
  audience: string
  account: Address
  payee: Address
  signingKey: Address
  nonce: Hex
  expiry: bigint
}

/** The digest each signer of a registration signs, under the sandbox's own domain. */
export function registrationDigest(
  domain: ReturnType<typeof registrationDomain>,
  r:
    | { kind: 'business'; registration: BusinessRegistration }
    | { kind: 'supplier'; registration: SupplierRegistration },
): Hex {
  return r.kind === 'business'
    ? hashTypedData({
        domain,
        types: REGISTRATION_TYPES,
        primaryType: 'BusinessRegistration',
        message: r.registration,
      })
    : hashTypedData({
        domain,
        types: REGISTRATION_TYPES,
        primaryType: 'SupplierRegistration',
        message: r.registration,
      })
}

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => getAddress(s))
  .refine((a) => !isAddressEqual(a, zeroAddress), 'not the zero address')
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex)
const u64 = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform((s) => BigInt(s))
  .refine((v) => v < 2n ** 64n)
const signature = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})+$/)
  .transform((s) => s as Hex)
const common = {
  environment: z.literal(SANDBOX_ENVIRONMENT),
  audience: z.string().min(1).max(256),
  account: address,
  nonce: bytes32,
  expiry: u64,
}

/** The body of a business's registration request, as the API reads it. */
export const businessRegistrationBody = z.strictObject({
  registration: z.strictObject({
    ...common,
    lock: address,
    legalName: z.string().min(1).max(200),
    country: z.string().regex(/^[A-Z]{2}$/),
  }),
  accountSignature: signature,
})

/** The body of a supplier's registration request, as the API reads it. */
export const supplierRegistrationBody = z.strictObject({
  registration: z.strictObject({ ...common, payee: address, signingKey: address }),
  accountSignature: signature,
  signingKeySignature: signature,
})

/**
 * A business's registration, signed by its account's root key, as the body of the request that
 * registers it. The request around it has to be signed by the same root key, naming the business's
 * lock. It's valid for `validity` seconds from `now`, which the API holds to at most five minutes.
 */
export async function signBusinessRegistration(r: {
  chainId: number
  factory: Address
  /** The API's origin, which the registration names as its audience. */
  audience: string
  account: Address
  lock: Address
  legalName: string
  country: string
  now: bigint
  validity: bigint
  rootKey: HashSigner
}): Promise<{ registration: BusinessRegistration; accountSignature: Hex }> {
  const registration: BusinessRegistration = {
    environment: SANDBOX_ENVIRONMENT,
    audience: r.audience,
    account: r.account,
    lock: r.lock,
    legalName: r.legalName,
    country: r.country,
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    expiry: r.now + r.validity,
  }
  const digest = registrationDigest(registrationDomain(r.chainId, r.factory), {
    kind: 'business',
    registration,
  })
  return { registration, accountSignature: await r.rootKey.sign({ hash: digest }) }
}

/** What Avow answers a sandbox business's registration with: its id and the test dollars it paid. */
export interface SandboxRegistrationAnswer {
  businessId: string
  testData: true
  payout: { transactionHash: Hex; amount: bigint }
}

export const sandboxRegistrationAnswerJson = z.object({
  businessId: z.string().min(1),
  testData: z.literal(true),
  payout: z.object({
    transactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .transform((s) => s.toLowerCase() as Hex),
    amount: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .transform((s) => BigInt(s)),
  }),
})

/** Reads Avow's answer to a sandbox business's registration, ignoring fields it doesn't use. */
export function parseSandboxRegistrationAnswer(json: unknown): Parsed<SandboxRegistrationAnswer> {
  const parsed = sandboxRegistrationAnswerJson.safeParse(json)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: 'message.invalid' }
}
