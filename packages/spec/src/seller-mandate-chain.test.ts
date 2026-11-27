import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { digestOf, type Signed } from './eip712.js'
import { MAX_MANDATE_CHAIN } from './mandate-chain.js'
import { type SellerMandate, sellerMandateHash, sellerMandateTypedData } from './seller-mandate.js'
import {
  parseSellerMandates,
  type SellerMandates,
  sellerMandateChainProblem,
  sellerMandatesSignatureProblem,
} from './seller-mandate-chain.js'
import {
  type SellerMandateRevocation,
  sellerMandateRevocationTypedData,
} from './seller-mandate-revocation.js'
import {
  CHAIN_ID,
  DOMAIN,
  demoSellerMandate,
  id,
  LOCK,
  newKey,
  OTHER_LOCK,
} from './test-helpers.js'
import { toWire } from './wire.js'

const admin = newKey()
const stranger = newKey()
const ACCOUNT = admin.address.toLowerCase() as Address
const KEY: Address = '0x0000000000000000000000000000000000005e11'
const OTHER_KEY: Address = '0x0000000000000000000000000000000000005e12'
const expected = { domain: DOMAIN, businessId: 'biz_supplier', account: ACCOUNT, signingKey: KEY }

const envelope = <T>(type: Signed<T>['type'], message: T, signature: Hex): Signed<T> => ({
  type,
  schemaVersion: '1',
  chainId: CHAIN_ID,
  lock: LOCK,
  message,
  signature,
})
const signMandate = async (m: SellerMandate, by = admin) =>
  envelope('SellerMandate', m, await by.sign({ hash: digestOf(sellerMandateTypedData(m, DOMAIN)) }))
const signRevocation = async (r: SellerMandateRevocation, by = admin) =>
  envelope(
    'SellerMandateRevocation',
    r,
    await by.sign({ hash: digestOf(sellerMandateRevocationTypedData(r, DOMAIN)) }),
  )
const hashOf = (m: SellerMandate) => sellerMandateHash(m, DOMAIN)

// Three mandates for one key, each replacing the one before it.
const first = demoSellerMandate(ACCOUNT, KEY)
const second: SellerMandate = { ...first, mandateId: id('second'), replaces: hashOf(first) }
const third: SellerMandate = { ...second, mandateId: id('third'), replaces: hashOf(second) }
const revoking = (m: SellerMandate): SellerMandateRevocation => ({
  businessId: m.businessId,
  account: m.account,
  signingKey: m.signingKey,
  mandate: hashOf(m),
})

const chainOf = async (
  mandates: SellerMandate[],
  revoked: SellerMandate | null = null,
): Promise<SellerMandates> => {
  const [current, ...earlier] = await Promise.all(mandates.map((m) => signMandate(m)))
  if (!current) throw new Error('a chain holds at least one mandate')
  return { current, earlier, revocation: revoked ? await signRevocation(revoking(revoked)) : null }
}
const reason = (mandates: SellerMandates, want = expected) => {
  const read = sellerMandateChainProblem(mandates, want)
  return read.ok ? null : read.reason
}

describe("a chain of seller's mandates", () => {
  it('links from the newest back to the one that replaces none, and gives each hash', async () => {
    const mandates = await chainOf([third, second, first])
    expect(sellerMandateChainProblem(mandates, expected)).toEqual({
      ok: true,
      value: {
        current: { signed: mandates.current, hash: hashOf(third) },
        earlier: [hashOf(second), hashOf(first)],
      },
    })
    const alone = await chainOf([first])
    expect(sellerMandateChainProblem(alone, expected)).toEqual({
      ok: true,
      value: { current: { signed: alone.current, hash: hashOf(first) }, earlier: [] },
    })
  })

  it('refuses a chain with a mandate left out, slipped in, out of order or repeated', async () => {
    const mismatch = 'seller_mandate.chain_mismatch'
    // The middle left out, and the oldest left out, which leaves a mandate replacing one not there.
    expect(reason(await chainOf([third, first]))).toBe(mismatch)
    expect(reason(await chainOf([third, second]))).toBe(mismatch)
    expect(reason(await chainOf([second]))).toBe(mismatch)
    expect(reason(await chainOf([first, second, third]))).toBe(mismatch)
    expect(reason(await chainOf([third, second, second, first]))).toBe(mismatch)
    // A second first mandate can't ride along behind the chain's own.
    const another: SellerMandate = { ...first, mandateId: id('another first') }
    expect(reason(await chainOf([third, second, first, another]))).toBe(mismatch)
    // A mandate that names a hash no mandate in the chain has.
    const astray: SellerMandate = { ...second, replaces: id('some other mandate') }
    expect(reason(await chainOf([astray, first]))).toBe(mismatch)
  })

  it('refuses a chain for another key, business or account, whoever signed it', async () => {
    expect(
      reason(await chainOf([third, second, first]), { ...expected, signingKey: OTHER_KEY }),
    ).toBe('seller_mandate.key_mismatch')
    const mismatch = 'seller_mandate.chain_mismatch'
    expect(reason(await chainOf([first]), { ...expected, businessId: 'biz_other' })).toBe(mismatch)
    // A stranger's account signs a sound mandate for this agent's key.
    const theirs = demoSellerMandate(stranger.address.toLowerCase() as Address, KEY)
    const forged: SellerMandates = {
      current: await signMandate(theirs, stranger),
      earlier: [],
      revocation: null,
    }
    expect(reason(forged)).toBe(mismatch)
    // One link of an honest chain swapped for the stranger's.
    const swapped = await chainOf([second, first])
    const link: SellerMandate = { ...theirs, replaces: null }
    expect(reason({ ...swapped, earlier: [await signMandate(link, stranger)] })).toBe(mismatch)
  })

  it("refuses a mandate that isn't well formed or sits in another envelope", async () => {
    const mandates = await chainOf([second, first])
    const bad = { ...mandates.current, message: { ...second, maxOrderValue: 0n } }
    expect(reason({ ...mandates, current: bad })).toBe('seller_mandate.invalid')
    expect(reason({ ...mandates, current: { ...mandates.current, lock: OTHER_LOCK } })).toBe(
      'message.invalid',
    )
    const [older] = mandates.earlier
    if (!older) throw new Error('the chain holds two mandates')
    expect(reason({ ...mandates, earlier: [{ ...older, chainId: CHAIN_ID + 1 }] })).toBe(
      'message.invalid',
    )
    expect(
      reason(mandates, { ...expected, domain: { ...DOMAIN, verifyingContract: OTHER_LOCK } }),
    ).toBe('message.invalid')
  })

  it('never throws, whatever it is handed', async () => {
    const mandates = await chainOf([first])
    const junk = [
      null,
      undefined,
      7,
      'a chain',
      [],
      {},
      { current: null, earlier: [], revocation: null },
    ]
    for (const value of junk) expect(reason(value as never)).toBe('message.invalid')
    expect(reason({ ...mandates, earlier: 'none' as never })).toBe('message.invalid')
    expect(reason({ ...mandates, earlier: [null as never] })).toBe('message.invalid')
    expect(reason({ ...mandates, revocation: 'revoked' as never })).toBe('message.invalid')
    expect(reason({ ...mandates, revocation: undefined as never })).toBe('message.invalid')
    const sparse = [mandates.current, mandates.current]
    delete sparse[0]
    expect(reason({ ...mandates, earlier: sparse })).toBe('message.invalid')
    const thrower = new Proxy(mandates, {
      get() {
        throw new Error('read')
      },
    })
    expect(reason(thrower)).toBe('message.invalid')
  })

  it("holds no more mandates than a buyer's chain", async () => {
    const signed = await signMandate(first)
    const long = {
      current: signed,
      earlier: Array(MAX_MANDATE_CHAIN).fill(signed),
      revocation: null,
    }
    expect(reason(long)).toBe('message.invalid')
  })
})

describe('a revocation served with a chain', () => {
  it('ends the whole chain, whichever mandate in it the revocation names', async () => {
    for (const revoked of [third, second, first]) {
      expect(reason(await chainOf([third, second, first], revoked))).toBe('seller_mandate.revoked')
    }
    expect(reason(await chainOf([first], first))).toBe('seller_mandate.revoked')
  })

  it('ends the chain whoever signed the revocation, since a forged one only stops a sale', async () => {
    const mandates = await chainOf([second, first])
    const forged = await signRevocation(revoking(second), stranger)
    expect(reason({ ...mandates, revocation: forged })).toBe('seller_mandate.revoked')
  })

  it('refuses a revocation that names no mandate in the chain, or another agent', async () => {
    const mandates = await chainOf([second, first])
    const refused = async (r: SellerMandateRevocation) =>
      reason({ ...mandates, revocation: await signRevocation(r) })
    // A mandate that replaces the chain's newest isn't in the chain it was served with.
    expect(await refused(revoking(third))).toBe('message.invalid')
    expect(await refused({ ...revoking(second), signingKey: OTHER_KEY })).toBe('message.invalid')
    expect(await refused({ ...revoking(second), businessId: 'biz_other' })).toBe('message.invalid')
    expect(await refused({ ...revoking(second), account: OTHER_KEY })).toBe('message.invalid')
    const sound = await signRevocation(revoking(second))
    const malformed = { ...sound, message: { ...sound.message, mandate: '0x12' as const } }
    expect(reason({ ...mandates, revocation: malformed })).toBe('message.invalid')
    expect(reason({ ...mandates, revocation: { ...sound, lock: OTHER_LOCK } })).toBe(
      'message.invalid',
    )
  })

  it('reports a broken chain before a revocation', async () => {
    const mandates = await chainOf([third, first], first)
    expect(reason(mandates)).toBe('seller_mandate.chain_mismatch')
  })
})

describe("the signatures on a chain of seller's mandates", () => {
  it('pass when the account signed every mandate', async () => {
    const mandates = await chainOf([third, second, first])
    expect(await sellerMandatesSignatureProblem(mandates, expected)).toBeNull()
  })

  it('fail when anyone else signed one, the replaced ones included', async () => {
    const mandates = await chainOf([third, second, first])
    const invalid = 'seller_mandate.signature_invalid'
    const forged = await signMandate(third, stranger)
    expect(await sellerMandatesSignatureProblem({ ...mandates, current: forged }, expected)).toBe(
      invalid,
    )
    const [newer] = mandates.earlier
    if (!newer) throw new Error('the chain holds three mandates')
    const oldForged = await signMandate(first, stranger)
    expect(
      await sellerMandatesSignatureProblem({ ...mandates, earlier: [newer, oldForged] }, expected),
    ).toBe(invalid)
    // A signature over one mandate doesn't sign another.
    const moved = { ...mandates.current, signature: newer.signature }
    expect(await sellerMandatesSignatureProblem({ ...mandates, current: moved }, expected)).toBe(
      invalid,
    )
    expect(
      await sellerMandatesSignatureProblem(mandates, { ...expected, account: stranger.address }),
    ).toBe(invalid)
  })

  it("takes the caller's own check, for an account whose root key is a passkey", async () => {
    const mandates = await chainOf([second, first])
    const seen: Address[] = []
    const check = async ({ signer }: { signer: Address }) => {
      seen.push(signer)
      return true
    }
    expect(await sellerMandatesSignatureProblem(mandates, expected, check)).toBeNull()
    expect(seen).toEqual([ACCOUNT, ACCOUNT])
  })
})

describe("reading a key's seller's mandates from JSON", () => {
  const wire = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
  const where = { chainId: CHAIN_ID, lock: LOCK }
  const read = (json: unknown) => {
    const parsed = parseSellerMandates(json, where)
    return parsed.ok ? null : parsed.reason
  }

  it('reads back as written, with a revocation and without', async () => {
    const plain = await chainOf([third, second, first])
    expect(parseSellerMandates(wire(plain), where)).toEqual({ ok: true, value: plain })
    const revoked = await chainOf([second, first], first)
    expect(parseSellerMandates(wire(revoked), where)).toEqual({ ok: true, value: revoked })
  })

  it('refuses a missing field, a field it does not know and a chain too long', async () => {
    const json = wire(await chainOf([second, first]))
    for (const value of [null, 7, 'chain', [], {}]) expect(read(value)).toBe('message.invalid')
    const { revocation: _, ...noRevocation } = json
    expect(read(noRevocation)).toBe('message.invalid')
    expect(read({ ...json, next: json.current })).toBe('message.invalid')
    expect(read({ ...json, earlier: null })).toBe('message.invalid')
    expect(read({ ...json, earlier: Array(MAX_MANDATE_CHAIN).fill(json.current) })).toBe(
      'message.invalid',
    )
    expect(read({ ...json, earlier: Array(MAX_MANDATE_CHAIN - 1).fill(json.current) })).toBeNull()
  })

  it("refuses a mandate or a revocation that doesn't parse, with its own reason", async () => {
    const json = wire(await chainOf([second, first], second))
    expect(read({ ...json, current: { ...json.current, lock: OTHER_LOCK } })).toBe(
      'message.wrong_contract',
    )
    expect(read({ ...json, earlier: [{ ...json.earlier[0], schemaVersion: '2' }] })).toBe(
      'message.schema_unknown',
    )
    expect(read({ ...json, earlier: [null] })).toBe('message.invalid')
    expect(read({ ...json, revocation: { ...json.revocation, chainId: CHAIN_ID + 1 } })).toBe(
      'message.wrong_chain',
    )
    expect(read({ ...json, revocation: json.current })).toBe('message.schema_unknown')
  })
})
