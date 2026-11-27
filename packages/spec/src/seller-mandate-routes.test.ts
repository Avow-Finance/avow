import { type Address, getAddress, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'
import { apiRequestProblem, encodeApiBody } from './api-request.js'
import { digestOf, type Signed } from './eip712.js'
import { MAX_MANDATE_CHAIN } from './mandate-chain.js'
import { SANDBOX_PATHS } from './sandbox.js'
import { type SellerKeyRevocation, sellerKeyRevocationTypedData } from './seller-key-revocation.js'
import { type SellerMandate, sellerMandateHash, sellerMandateTypedData } from './seller-mandate.js'
import {
  parseSellerMandates,
  type SellerMandates,
  sellerMandateChainProblem,
  sellerMandatesJson,
} from './seller-mandate-chain.js'
import {
  parseSellerMandatePost,
  parseSellerMandateReceipt,
  parseSellerMandatesRequest,
  type SellerMandateReceipt,
} from './seller-mandate-routes.js'
import {
  CHAIN_ID,
  DOMAIN,
  demoSellerMandate,
  id,
  LOCK,
  newKey,
  OTHER_LOCK,
} from './test-helpers.js'
import { MESSAGE_VERSIONS } from './version.js'
import { toWire } from './wire.js'

const admin = newKey()
const ACCOUNT = admin.address.toLowerCase() as Address
const KEY: Address = '0x0000000000000000000000000000000000005e11'
const where = { chainId: CHAIN_ID, lock: LOCK }

/** A value as it crosses JSON between whoever posts, Avow's API and the agent. */
const overJson = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
const upper = (hex: string) => `0x${hex.slice(2).toUpperCase()}`

const signMandate = async (message: SellerMandate): Promise<Signed<SellerMandate>> => ({
  type: 'SellerMandate',
  schemaVersion: MESSAGE_VERSIONS.SellerMandate,
  chainId: CHAIN_ID,
  lock: LOCK,
  message,
  signature: await admin.sign({ hash: digestOf(sellerMandateTypedData(message, DOMAIN)) }),
})
const signRevocation = async (
  message: SellerKeyRevocation,
): Promise<Signed<SellerKeyRevocation>> => ({
  type: 'SellerKeyRevocation',
  schemaVersion: MESSAGE_VERSIONS.SellerKeyRevocation,
  chainId: CHAIN_ID,
  lock: LOCK,
  message,
  signature: await admin.sign({ hash: digestOf(sellerKeyRevocationTypedData(message, DOMAIN)) }),
})

const first = demoSellerMandate(ACCOUNT, KEY)
const second: SellerMandate = {
  ...first,
  mandateId: id('second'),
  replaces: sellerMandateHash(first, DOMAIN),
}

/** Values no body or answer is, which a parser refuses and never throws on. */
const JUNK: unknown[] = [undefined, null, 7, true, 'mandate', [], [{}], () => ({})]
/** A value that throws when a field of it is read, as nothing from JSON does. */
const throwing = (field: string) =>
  Object.defineProperty({}, field, {
    enumerable: true,
    get() {
      throw new Error('read')
    },
  })

describe("the paths for a seller's mandate", () => {
  it('names the signing key in lower case in the path a mandate is posted to', () => {
    expect(SANDBOX_PATHS.sellerMandate(KEY)).toBe(`/v1/sandbox/sellers/${KEY}/mandate`)
    expect(SANDBOX_PATHS.sellerMandate(getAddress(KEY))).toBe(SANDBOX_PATHS.sellerMandate(KEY))
    expect(SANDBOX_PATHS.sellerMandates).toBe('/v1/sandbox/sellers/mandates')
  })

  it("refuses a signing key that isn't an address", () => {
    for (const bad of [
      '',
      'mandates',
      '../agents',
      KEY.slice(2),
      KEY.slice(0, -1),
      `${KEY}0`,
      `${KEY}/mandate`,
      `0x${'g'.repeat(40)}`,
      sellerMandateHash(first, DOMAIN),
    ]) {
      expect(() => SANDBOX_PATHS.sellerMandate(bad as Address), bad).toThrow(RangeError)
    }
  })

  it('gives the agent a path and an empty body that a signed request takes', () => {
    const request = { audience: 'https://api.testnet.avow.finance', method: 'POST' }
    const body = encodeApiBody({})
    expect(apiRequestProblem({ ...request, path: SANDBOX_PATHS.sellerMandates, body })).toBeNull()
    expect(new TextDecoder().decode(body)).toBe('{}')
  })
})

describe("the body that posts a seller's mandate", () => {
  it('reads back as written, a first mandate and one that replaces it', async () => {
    for (const m of [first, second]) {
      const post = { mandate: await signMandate(m) }
      expect(parseSellerMandatePost(overJson(post), where)).toEqual({ ok: true, value: post })
      // The route is unsigned, so a reader may not know the lock before it reads the business.
      expect(parseSellerMandatePost(overJson(post), { chainId: CHAIN_ID })).toEqual({
        ok: true,
        value: post,
      })
    }
  })

  it('refuses a field it does not know, a missing mandate and junk, without throwing', async () => {
    const json = overJson({ mandate: await signMandate(first) })
    const reason = (value: unknown) => {
      const parsed = parseSellerMandatePost(value, where)
      return parsed.ok ? null : parsed.reason
    }
    expect(reason(json)).toBeNull()
    for (const value of [...JUNK, {}, throwing('mandate')]) {
      expect(reason(value)).toBe('message.invalid')
    }
    expect(reason({ ...json, signingKey: KEY })).toBe('message.invalid')
    expect(reason({ mandate: null })).toBe('message.invalid')
    expect(reason({ mandate: [json.mandate] })).toBe('message.invalid')
    expect(reason({ mandate: 'signed' })).toBe('message.invalid')
    // The message alone, with no envelope around it.
    expect(reason({ mandate: json.mandate.message })).toBe('message.invalid')
    expect(reason({ mandate: { ...json.mandate, note: 'hello' } })).toBe('message.invalid')
  })

  it("keeps the reason a mandate that doesn't parse is refused for", async () => {
    const { mandate } = overJson({ mandate: await signMandate(second) })
    const reason = (changed: object, message: object = {}) => {
      const parsed = parseSellerMandatePost(
        { mandate: { ...mandate, ...changed, message: { ...mandate.message, ...message } } },
        where,
      )
      return parsed.ok ? null : parsed.reason
    }
    expect(reason({})).toBeNull()
    expect(reason({ chainId: CHAIN_ID + 1 })).toBe('message.wrong_chain')
    expect(reason({ lock: OTHER_LOCK })).toBe('message.wrong_contract')
    expect(reason({ schemaVersion: '2' })).toBe('message.schema_unknown')
    expect(reason({ type: 'Mandate' })).toBe('message.schema_unknown')
    expect(reason({ signature: 'signed' })).toBe('message.invalid')
    expect(reason({}, { maxOrderValue: 500_000_000 })).toBe('message.invalid')
    expect(reason({}, { limits: [] })).toBe('seller_mandate.invalid')
    expect(reason({}, { replaces: zeroHash })).toBe('seller_mandate.invalid')
  })

  it('reads hex in either case, as a signed message does on the wire', async () => {
    const post = { mandate: await signMandate(second) }
    const json = overJson(post)
    json.mandate.message.replaces = upper(json.mandate.message.replaces)
    json.mandate.message.signingKey = getAddress(KEY)
    expect(parseSellerMandatePost(json, where)).toEqual({ ok: true, value: post })
  })
})

describe("the receipt for a posted seller's mandate", () => {
  const receipt: SellerMandateReceipt = {
    mandateHash: sellerMandateHash(second, DOMAIN),
    replaces: sellerMandateHash(first, DOMAIN),
    recordedAt: 1_800_000_000n,
    current: true,
  }
  // The first mandate as Avow answered when it recorded it, and again once the second replaced it.
  const firstReceipt: SellerMandateReceipt = {
    mandateHash: sellerMandateHash(first, DOMAIN),
    replaces: null,
    recordedAt: 1_799_999_000n,
    current: true,
  }
  const firstReposted: SellerMandateReceipt = { ...firstReceipt, current: false }
  // The second posted again once the key was revoked would be refused, so it is never current again.
  const afterRevocation: SellerMandateReceipt = { ...receipt, current: false }

  it('reads back as written, with its time as a decimal string', () => {
    for (const r of [receipt, firstReceipt, firstReposted, afterRevocation]) {
      expect(parseSellerMandateReceipt(overJson(r))).toEqual({ ok: true, value: r })
    }
    expect(overJson(receipt).recordedAt).toBe('1800000000')
  })

  it('differs between two answers for one mandate only in whether it is current', () => {
    for (const [before, after] of [
      [firstReceipt, firstReposted],
      [receipt, afterRevocation],
    ] as const) {
      const { current: was, ...stable } = before
      const { current: is, ...still } = after
      expect(still).toEqual(stable)
      expect([was, is]).toEqual([true, false])
    }
  })

  it("holds none of the mandate's terms", () => {
    expect(Object.keys(overJson(receipt)).sort()).toEqual([
      'current',
      'mandateHash',
      'recordedAt',
      'replaces',
    ])
    const terms = overJson(second)
    for (const field of ['limits', 'maxOrderValue', 'buyers', 'signingKey', 'businessId']) {
      expect(parseSellerMandateReceipt({ ...overJson(receipt), [field]: terms[field] }).ok).toBe(
        false,
      )
    }
  })

  it('refuses a field it does not know, a missing field and a value of the wrong type', () => {
    const json = overJson(receipt)
    const bad: unknown[] = [
      { ...json, note: 'hello' },
      { ...json, mandateHash: undefined },
      { ...json, replaces: undefined },
      { ...json, recordedAt: undefined },
      { ...json, current: undefined },
      { ...json, mandateHash: null },
      { ...json, mandateHash: 7 },
      { ...json, mandateHash: json.mandateHash.slice(0, -2) },
      { ...json, mandateHash: `${json.mandateHash}00` },
      { ...json, mandateHash: json.mandateHash.slice(2) },
      { ...json, replaces: '' },
      { ...json, replaces: KEY },
      { ...json, replaces: zeroHash },
      { ...json, recordedAt: 1_800_000_000 },
      { ...json, recordedAt: '1800000000.5' },
      { ...json, recordedAt: '-1' },
      { ...json, recordedAt: '01800000000' },
      { ...json, recordedAt: (2n ** 64n).toString() },
      { ...json, current: 'true' },
      { ...json, current: 1 },
      { ...json, current: null },
    ]
    for (const value of bad) {
      expect(parseSellerMandateReceipt(value), JSON.stringify(value)).toEqual({
        ok: false,
        reason: 'message.invalid',
      })
    }
  })

  it('reads a hash in upper or mixed case and gives it back in lower case', () => {
    const json = overJson(receipt)
    const mixed = (hex: string) => hex.replace(/[a-f]/, (c) => c.toUpperCase())
    for (const change of [upper, mixed]) {
      expect(change(json.mandateHash)).not.toBe(json.mandateHash)
      const changed = {
        ...json,
        mandateHash: change(json.mandateHash),
        replaces: change(json.replaces),
      }
      expect(parseSellerMandateReceipt(changed)).toEqual({ ok: true, value: receipt })
    }
    // A prefix of `0X` is no hex a reader takes.
    const prefix = { ...json, mandateHash: json.mandateHash.replace('0x', '0X') }
    expect(parseSellerMandateReceipt(prefix).ok).toBe(false)
  })

  it('never throws, whatever it is given', () => {
    for (const value of [...JUNK, {}, throwing('mandateHash'), throwing('current')]) {
      expect(parseSellerMandateReceipt(value)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })
})

describe("the body of an agent's read of its seller's mandates", () => {
  it('is an empty object, and reads back as one', () => {
    expect(parseSellerMandatesRequest(overJson({}))).toEqual({ ok: true, value: {} })
    expect(
      parseSellerMandatesRequest(JSON.parse(new TextDecoder().decode(encodeApiBody({})))),
    ).toEqual({ ok: true, value: {} })
  })

  it('refuses any field and junk, without throwing', () => {
    for (const value of [
      ...JUNK,
      { signingKey: KEY },
      { businessId: 'biz_supplier' },
      { mandate: null },
      throwing('signingKey'),
    ]) {
      expect(parseSellerMandatesRequest(value)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })
})

describe("the seller's mandates served to an agent", () => {
  const revocation: SellerKeyRevocation = {
    businessId: first.businessId,
    account: ACCOUNT,
    signingKey: KEY,
  }
  const served = async (revoked = false): Promise<SellerMandates> => ({
    current: await signMandate(second),
    earlier: [await signMandate(first)],
    revocation: revoked ? await signRevocation(revocation) : null,
  })

  it('parses with the chain reader the agent already has, and reads on into one chain', async () => {
    const mandates = await served()
    const json = overJson(mandates)
    expect(sellerMandatesJson.safeParse(json).success).toBe(true)
    const parsed = parseSellerMandates(json, where)
    expect(parsed).toEqual({ ok: true, value: mandates })
    if (!parsed.ok) throw new Error(parsed.reason)
    const chain = await sellerMandateChainProblem(parsed.value, {
      domain: DOMAIN,
      businessId: first.businessId,
      account: ACCOUNT,
      signingKey: KEY,
    })
    expect(chain.ok && chain.value.current.hash).toBe(sellerMandateHash(second, DOMAIN))
  })

  it("carries a revoked key's revocation, which ends the chain when it is read", async () => {
    const mandates = await served(true)
    const json = overJson(mandates)
    expect(sellerMandatesJson.safeParse(json).success).toBe(true)
    const parsed = parseSellerMandates(json, where)
    expect(parsed).toEqual({ ok: true, value: mandates })
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(
      await sellerMandateChainProblem(parsed.value, {
        domain: DOMAIN,
        businessId: first.businessId,
        account: ACCOUNT,
        signingKey: KEY,
      }),
    ).toEqual({ ok: false, reason: 'seller_mandate.revoked' })
  })

  it('has an outer shape that refuses what the chain reader refuses', async () => {
    const json = overJson(await served())
    const { revocation: _, ...noRevocation } = json
    const refused: unknown[] = [
      ...JUNK,
      {},
      noRevocation,
      { ...json, next: json.current },
      { ...json, receipt: null },
      { ...json, current: null },
      { ...json, current: 'signed' },
      { ...json, earlier: null },
      { ...json, earlier: json.current },
      { ...json, earlier: [null] },
      { ...json, earlier: Array(MAX_MANDATE_CHAIN).fill(json.current) },
      { ...json, revocation: 'revoked' },
      { ...json, revocation: [] },
    ]
    for (const value of refused) {
      expect(sellerMandatesJson.safeParse(value).success, JSON.stringify(value)).toBe(false)
      expect(parseSellerMandates(value, where).ok, JSON.stringify(value)).toBe(false)
    }
    const longest = { ...json, earlier: Array(MAX_MANDATE_CHAIN - 1).fill(json.current) }
    expect(sellerMandatesJson.safeParse(longest).success).toBe(true)
    expect(parseSellerMandates(longest, where).ok).toBe(true)
  })
})
