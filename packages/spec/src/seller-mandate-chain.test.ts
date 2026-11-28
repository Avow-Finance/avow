import { type Address, getAddress, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { digestOf, type Signed } from './eip712.js'
import { MAX_MANDATE_CHAIN } from './mandate-chain.js'
import { type SellerKeyRevocation, sellerKeyRevocationTypedData } from './seller-key-revocation.js'
import {
  type SellerMandate,
  sellerMandateHash,
  sellerMandateTypedData,
  sellerMandateVersion,
} from './seller-mandate.js'
import {
  parseSellerMandates,
  type SellerMandates,
  sellerMandateChainProblem,
} from './seller-mandate-chain.js'
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
const signMandate = async (m: SellerMandate, by = admin) => ({
  ...envelope(
    'SellerMandate',
    m,
    await by.sign({ hash: digestOf(sellerMandateTypedData(m, DOMAIN)) }),
  ),
  schemaVersion: sellerMandateVersion(m),
})
const signRevocation = async (r: SellerKeyRevocation, by = admin) =>
  envelope(
    'SellerKeyRevocation',
    r,
    await by.sign({ hash: digestOf(sellerKeyRevocationTypedData(r, DOMAIN)) }),
  )
const hashOf = (m: SellerMandate) => sellerMandateHash(m, DOMAIN)

// Three mandates for one key, each replacing the one before it.
const first = demoSellerMandate(ACCOUNT, KEY)
const second: SellerMandate = { ...first, mandateId: id('second'), replaces: hashOf(first) }
const third: SellerMandate = { ...second, mandateId: id('third'), replaces: hashOf(second) }
const revocation: SellerKeyRevocation = {
  businessId: 'biz_supplier',
  account: ACCOUNT,
  signingKey: KEY,
}

const chainOf = async (mandates: SellerMandate[], revoked = false): Promise<SellerMandates> => {
  const [current, ...earlier] = await Promise.all(mandates.map((m) => signMandate(m)))
  if (!current) throw new Error('a chain holds at least one mandate')
  return { current, earlier, revocation: revoked ? await signRevocation(revocation) : null }
}
const reason = async (mandates: SellerMandates, want = expected) => {
  const read = await sellerMandateChainProblem(mandates, want)
  return read.ok ? null : read.reason
}
const mismatch = 'seller_mandate.chain_mismatch'

describe("a chain of seller's mandates", () => {
  it('links from the newest back to the one that replaces none, and gives each hash', async () => {
    const mandates = await chainOf([third, second, first])
    expect(await sellerMandateChainProblem(mandates, expected)).toEqual({
      ok: true,
      value: {
        current: { signed: mandates.current, hash: hashOf(third) },
        earlier: [hashOf(second), hashOf(first)],
      },
    })
    const alone = await chainOf([first])
    expect(await sellerMandateChainProblem(alone, expected)).toEqual({
      ok: true,
      value: { current: { signed: alone.current, hash: hashOf(first) }, earlier: [] },
    })
  })

  it('reads a mandate that lets its agent bargain, in the envelope of its own version', async () => {
    const bargaining: SellerMandate = {
      ...second,
      negotiable: ['unitPrice'],
      replaces: hashOf(first),
    }
    const mandates = await chainOf([bargaining, first])
    expect(mandates.current.schemaVersion).toBe('2')
    expect(await reason(mandates)).toBeNull()
    expect(
      await reason({ ...mandates, current: { ...mandates.current, schemaVersion: '1' } }),
    ).toBe('message.invalid')
    const plain = await chainOf([first])
    expect(await reason({ ...plain, current: { ...plain.current, schemaVersion: '2' } })).toBe(
      'message.invalid',
    )
  })

  it('reads the expected addresses in either case', async () => {
    const mixed = { ...expected, account: admin.address, signingKey: getAddress(KEY) }
    expect(await reason(await chainOf([second, first]), mixed)).toBeNull()
  })

  it('refuses a chain with a mandate left out, slipped in, out of order or repeated', async () => {
    // The middle left out, and the oldest left out, which leaves a mandate replacing one not there.
    expect(await reason(await chainOf([third, first]))).toBe(mismatch)
    expect(await reason(await chainOf([third, second]))).toBe(mismatch)
    expect(await reason(await chainOf([second]))).toBe(mismatch)
    expect(await reason(await chainOf([first, second, third]))).toBe(mismatch)
    expect(await reason(await chainOf([third, second, second, first]))).toBe(mismatch)
    // A second first mandate can't ride along behind the chain's own.
    const another: SellerMandate = { ...first, mandateId: id('another first') }
    expect(await reason(await chainOf([third, second, first, another]))).toBe(mismatch)
    // A mandate that names a hash no mandate in the chain has.
    const astray: SellerMandate = { ...second, replaces: id('some other mandate') }
    expect(await reason(await chainOf([astray, first]))).toBe(mismatch)
  })

  it('refuses a chain for another key, business or account, whoever signed it', async () => {
    const whole = await chainOf([third, second, first])
    expect(await reason(whole, { ...expected, signingKey: OTHER_KEY })).toBe(
      'seller_mandate.key_mismatch',
    )
    expect(await reason(whole, { ...expected, businessId: 'biz_other' })).toBe(mismatch)
    // A stranger's account signs a sound mandate for this agent's key.
    const theirs = demoSellerMandate(stranger.address.toLowerCase() as Address, KEY)
    const forged: SellerMandates = {
      current: await signMandate(theirs, stranger),
      earlier: [],
      revocation: null,
    }
    expect(await reason(forged)).toBe(mismatch)
    // One link of an honest chain swapped for the stranger's.
    const swapped = await chainOf([second, first])
    expect(await reason({ ...swapped, earlier: [await signMandate(theirs, stranger)] })).toBe(
      mismatch,
    )
  })

  it("refuses a mandate that isn't well formed or sits in another envelope", async () => {
    const mandates = await chainOf([second, first])
    const [older] = mandates.earlier
    if (!older) throw new Error('the chain holds two mandates')
    const withCurrent = (change: object) => ({
      ...mandates,
      current: { ...mandates.current, ...change },
    })
    const bad = { message: { ...second, maxOrderValue: 0n } }
    expect(await reason(withCurrent(bad))).toBe('seller_mandate.invalid')
    expect(await reason(withCurrent({ lock: OTHER_LOCK }))).toBe('message.wrong_contract')
    expect(await reason(withCurrent({ type: 'Mandate' }))).toBe('message.schema_unknown')
    expect(await reason(withCurrent({ schemaVersion: '99' }))).toBe('message.schema_unknown')
    expect(await reason(withCurrent({ signature: 7 }))).toBe('message.invalid')
    expect(await reason({ ...mandates, earlier: [{ ...older, chainId: CHAIN_ID + 1 }] })).toBe(
      'message.wrong_chain',
    )
    const otherLock = { ...expected, domain: { ...DOMAIN, verifyingContract: OTHER_LOCK } }
    expect(await reason(mandates, otherLock)).toBe('message.wrong_contract')
  })

  it('refuses a field nothing signed, beside the mandates or in an envelope', async () => {
    const mandates = await chainOf([second, first])
    expect(await reason({ ...mandates, note: 'trust me' } as never)).toBe('message.invalid')
    const padded = { ...mandates.current, approvedBy: 'the administrator' }
    expect(await reason({ ...mandates, current: padded })).toBe('message.invalid')
    const sound = await signRevocation(revocation)
    expect(await reason({ ...mandates, revocation: { ...sound, revokedAt: 1 } as never })).toBe(
      'message.invalid',
    )
  })

  it('refuses to read for a lock or a chain the caller never named', async () => {
    const mandates = await chainOf([first])
    const yes = async () => true
    for (const verifyingContract of [undefined, '', '0x12', null]) {
      const nowhere = {
        ...expected,
        domain: { ...DOMAIN, verifyingContract: verifyingContract as never },
      }
      expect(await sellerMandateChainProblem(mandates, nowhere, yes)).toEqual({
        ok: false,
        reason: 'message.invalid',
      })
    }
    const noChain = { ...expected, domain: { ...DOMAIN, chainId: undefined as never } }
    expect((await sellerMandateChainProblem(mandates, noChain, yes)).ok).toBe(false)
  })

  it('never throws, whatever it is handed', async () => {
    const mandates = await chainOf([first])
    const junk = [
      null,
      undefined,
      7,
      'chain',
      [],
      {},
      { current: null, earlier: [], revocation: null },
    ]
    for (const value of junk) expect(await reason(value as never)).toBe('message.invalid')
    expect(await reason({ ...mandates, earlier: 'none' as never })).toBe('message.invalid')
    expect(await reason({ ...mandates, earlier: [null as never] })).toBe('message.invalid')
    expect(
      await reason({ ...mandates, current: { ...mandates.current, message: null as never } }),
    ).toBe('seller_mandate.invalid')
    expect(await reason({ ...mandates, revocation: 'revoked' as never })).toBe('message.invalid')
    expect(await reason({ ...mandates, revocation: undefined as never })).toBe('message.invalid')
    const sparse = [mandates.current, mandates.current]
    delete sparse[0]
    expect(await reason({ ...mandates, earlier: sparse })).toBe('message.invalid')
    const thrower = new Proxy(mandates, {
      get() {
        throw new Error('read')
      },
    })
    expect(await reason(thrower)).toBe('message.invalid')
  })

  it('hands back the mandate it checked, whatever the value it was handed does next', async () => {
    const honest = await signMandate(first)
    const raised = await signMandate({ ...first, maxOrderValue: first.maxOutstanding })
    let reads = 0
    const shifting = {
      get current() {
        reads += 1
        return reads === 1 ? honest : raised
      },
      earlier: [],
      revocation: null,
    }
    const read = await sellerMandateChainProblem(shifting, expected)
    if (!read.ok) throw new Error(read.reason)
    expect(read.value.current.signed).toEqual(honest)
    expect(read.value.current.hash).toBe(hashOf(first))
  })

  it("holds as many mandates as a buyer's chain, and no more", async () => {
    const line: SellerMandate[] = [first]
    while (line.length < MAX_MANDATE_CHAIN + 1) {
      const before = line[line.length - 1] as SellerMandate
      line.push({ ...first, mandateId: id(`mandate ${line.length}`), replaces: hashOf(before) })
    }
    // Who signed is checked elsewhere, so these carry a stand-in signature and a check that passes.
    const [current, ...earlier] = line.reverse().map((m) => envelope('SellerMandate', m, '0x00'))
    if (!current) throw new Error('the line holds a mandate')
    const signed = async () => true
    const longest = {
      current: earlier[0] as typeof current,
      earlier: earlier.slice(1),
      revocation: null,
    }
    expect((await sellerMandateChainProblem(longest, expected, signed)).ok).toBe(true)
    const tooLong = { current, earlier, revocation: null }
    expect(await sellerMandateChainProblem(tooLong, expected, signed)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
  }, 30_000)
})

describe("who signed a chain of seller's mandates", () => {
  const invalid = 'seller_mandate.signature_invalid'

  it('has to be the business account, for every mandate, the replaced ones too', async () => {
    const mandates = await chainOf([third, second, first])
    const [newer] = mandates.earlier
    if (!newer) throw new Error('the chain holds three mandates')
    expect(await reason({ ...mandates, current: await signMandate(third, stranger) })).toBe(invalid)
    const oldForged = await signMandate(first, stranger)
    expect(await reason({ ...mandates, earlier: [newer, oldForged] })).toBe(invalid)
    // A signature over one mandate doesn't sign another, and no signature signs none.
    expect(
      await reason({ ...mandates, current: { ...mandates.current, signature: newer.signature } }),
    ).toBe(invalid)
    expect(await reason({ ...mandates, current: { ...mandates.current, signature: '0x' } })).toBe(
      invalid,
    )
  })

  it('refuses a sound chain an agent wrote for itself with limits nobody signed', async () => {
    const raised: SellerMandate = { ...third, maxOutstanding: third.maxOutstanding * 100n }
    const agent = newKey()
    const mandates = await chainOf([second, first])
    const forged = {
      ...mandates,
      current: await signMandate({ ...raised, replaces: hashOf(second) }, agent),
    }
    expect(await reason({ ...forged, earlier: [mandates.current, ...mandates.earlier] })).toBe(
      invalid,
    )
  })

  it("takes the caller's own check, for an account whose root key is a passkey", async () => {
    const mandates = await chainOf([second, first])
    const seen: Address[] = []
    const check = async ({ signer }: { signer: Address }) => {
      seen.push(signer)
      return true
    }
    expect((await sellerMandateChainProblem(mandates, expected, check)).ok).toBe(true)
    expect(seen).toEqual([ACCOUNT, ACCOUNT])
    const refuse = async () => false
    expect(await sellerMandateChainProblem(mandates, expected, refuse)).toEqual({
      ok: false,
      reason: invalid,
    })
  })

  it('passes only when the check answers a plain true', async () => {
    const mandates = await chainOf([first])
    for (const answer of ['no', 1, {}, undefined, null]) {
      const check = (async () => answer) as never
      expect(await sellerMandateChainProblem(mandates, expected, check)).toEqual({
        ok: false,
        reason: invalid,
      })
    }
  })

  it('refuses a signature that is no hex, before any check reads it', async () => {
    const mandates = await chainOf([first])
    const anything = {
      ...mandates,
      current: { ...mandates.current, signature: 'anything' as never },
    }
    const yes = async () => true
    expect(await sellerMandateChainProblem(anything, expected, yes)).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
  })

  it("lets the caller's check fail loudly, so an outage isn't read as a forgery", async () => {
    const down = async () => {
      throw new Error('the chain is unreachable')
    }
    await expect(sellerMandateChainProblem(await chainOf([first]), expected, down)).rejects.toThrow(
      'the chain is unreachable',
    )
  })
})

describe("a revocation served with a key's mandates", () => {
  it('ends the chain, however many mandates it holds', async () => {
    expect(await reason(await chainOf([third, second, first], true))).toBe('seller_mandate.revoked')
    expect(await reason(await chainOf([first], true))).toBe('seller_mandate.revoked')
  })

  it('ends a new first mandate for the key too, since it names the key and no mandate', async () => {
    const again: SellerMandate = { ...first, mandateId: id('starting again') }
    expect(await reason(await chainOf([again], true))).toBe('seller_mandate.revoked')
    const sibling: SellerMandate = { ...second, mandateId: id('a second replacement') }
    expect(await reason(await chainOf([sibling, first], true))).toBe('seller_mandate.revoked')
  })

  it('ends the chain whoever signed the revocation, since a forged one only stops a sale', async () => {
    const mandates = await chainOf([second, first])
    const forged = await signRevocation(revocation, stranger)
    expect(await reason({ ...mandates, revocation: forged })).toBe('seller_mandate.revoked')
    expect(await reason({ ...mandates, revocation: { ...forged, signature: '0x' } })).toBe(
      'seller_mandate.revoked',
    )
  })

  it('refuses a revocation for another agent, or in another envelope', async () => {
    const mandates = await chainOf([second, first])
    const refused = async (r: SellerKeyRevocation) =>
      reason({ ...mandates, revocation: await signRevocation(r) })
    expect(await refused({ ...revocation, signingKey: OTHER_KEY })).toBe('message.invalid')
    expect(await refused({ ...revocation, businessId: 'biz_other' })).toBe('message.invalid')
    expect(await refused({ ...revocation, account: OTHER_KEY })).toBe('message.invalid')
    const sound = await signRevocation(revocation)
    const served = (change: object) => reason({ ...mandates, revocation: { ...sound, ...change } })
    expect(await served({ lock: OTHER_LOCK })).toBe('message.wrong_contract')
    expect(await served({ type: 'SellerMandate' })).toBe('message.schema_unknown')
    expect(await served({ message: { ...revocation, mandate: hashOf(second) } })).toBe(
      'message.invalid',
    )
  })

  it('reports a broken chain before a revocation', async () => {
    expect(await reason(await chainOf([third, first], true))).toBe(mismatch)
  })
})

describe('what a reader of one chain cannot see', () => {
  // Each of these passes, and whoever stores mandates has to refuse it or serve the revocation.
  it('a newer mandate or a revocation its server left out', async () => {
    expect(await reason(await chainOf([first]))).toBeNull()
    expect(await reason(await chainOf([second, first]))).toBeNull()
  })

  it('a second mandate signed to replace the same one', async () => {
    const sibling: SellerMandate = { ...second, mandateId: id('a second replacement') }
    expect(await reason(await chainOf([sibling, first]))).toBeNull()
  })

  it('a second first mandate for the key', async () => {
    const again: SellerMandate = { ...first, mandateId: id('starting again') }
    expect(await reason(await chainOf([again]))).toBeNull()
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
    const revoked = await chainOf([second, first], true)
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

  it('reads on into one chain, with hex in either case on the wire', async () => {
    const mandates = await chainOf([third, second, first])
    const json = wire(mandates)
    json.current.message.replaces = json.current.message.replaces
      .replace('0x', '0X')
      .toUpperCase()
      .replace('0X', '0x')
    const parsed = parseSellerMandates(json, where)
    if (!parsed.ok) throw new Error(parsed.reason)
    const chain = await sellerMandateChainProblem(parsed.value, expected)
    expect(chain.ok && chain.value.current.hash).toBe(hashOf(third))
  })

  it("refuses a mandate or a revocation that doesn't parse, with its own reason", async () => {
    const json = wire(await chainOf([second, first], true))
    expect(read({ ...json, current: { ...json.current, lock: OTHER_LOCK } })).toBe(
      'message.wrong_contract',
    )
    expect(read({ ...json, earlier: [{ ...json.earlier[0], schemaVersion: '3' }] })).toBe(
      'message.schema_unknown',
    )
    expect(read({ ...json, earlier: [null] })).toBe('message.invalid')
    expect(read({ ...json, revocation: { ...json.revocation, chainId: CHAIN_ID + 1 } })).toBe(
      'message.wrong_chain',
    )
    expect(read({ ...json, revocation: json.current })).toBe('message.schema_unknown')
  })
})
