import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { digestOf, type Signed } from './eip712.js'
import { type SellerMandate, sellerMandateHash } from './seller-mandate.js'
import {
  parseSellerMandateRevocation,
  revokesSellerMandate,
  SELLER_MANDATE_REVOCATION_TYPES,
  type SellerMandateRevocation,
  sellerMandateRevocationHash,
  sellerMandateRevocationProblem,
  sellerMandateRevocationSignatureProblem,
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
import { MESSAGE_VERSIONS } from './version.js'
import { toWire } from './wire.js'

const admin = newKey()
const stranger = newKey()
const ACCOUNT = admin.address.toLowerCase() as Address
const KEY: Address = '0x0000000000000000000000000000000000005e11'
const OTHER_KEY: Address = '0x0000000000000000000000000000000000005e12'

const mandate = demoSellerMandate(ACCOUNT, KEY)
const revocation: SellerMandateRevocation = {
  businessId: mandate.businessId,
  account: ACCOUNT,
  signingKey: KEY,
  mandate: sellerMandateHash(mandate, DOMAIN),
}
const withRevocation = (change: Partial<SellerMandateRevocation>) => ({ ...revocation, ...change })
const signed = async (r = revocation, by = admin): Promise<Signed<SellerMandateRevocation>> => ({
  type: 'SellerMandateRevocation',
  schemaVersion: MESSAGE_VERSIONS.SellerMandateRevocation,
  chainId: CHAIN_ID,
  lock: LOCK,
  message: r,
  signature: await by.sign({ hash: digestOf(sellerMandateRevocationTypedData(r, DOMAIN)) }),
})

describe("a seller's mandate's revocation", () => {
  it('is well formed with its four fields in lower case', () => {
    expect(sellerMandateRevocationProblem(revocation)).toBeNull()
  })

  it('is refused with a field missing, added, of the wrong kind or not in lower case', () => {
    const changes: object[] = [
      { businessId: '' },
      { businessId: 7 },
      { businessId: 'a'.repeat(101) },
      { account: admin.address },
      { account: '0x12' },
      { signingKey: KEY.toUpperCase().replace('0X', '0x') },
      { signingKey: null },
      { mandate: `0x${'0'.repeat(64)}` },
      { mandate: `0x${'AB'.repeat(32)}` },
      { mandate: '0x1234' },
      { revokedAt: 1n },
    ]
    for (const change of changes) {
      expect(
        sellerMandateRevocationProblem(withRevocation(change)),
        JSON.stringify(toWire(change)),
      ).toBe('message.invalid')
    }
    const { signingKey: _, ...missing } = revocation
    expect(sellerMandateRevocationProblem(missing as never)).toBe('message.invalid')
    for (const value of [null, undefined, 'revoked', 7, []]) {
      expect(sellerMandateRevocationProblem(value as never)).toBe('message.invalid')
    }
    const thrower = new Proxy(revocation, {
      get() {
        throw new Error('read')
      },
    })
    expect(sellerMandateRevocationProblem(thrower)).toBe('message.invalid')
  })

  it('signs every field, under the lock and its own version', () => {
    const hash = sellerMandateRevocationHash(revocation, DOMAIN)
    const changes: Partial<SellerMandateRevocation>[] = [
      { businessId: 'biz_other' },
      { account: OTHER_KEY },
      { signingKey: OTHER_KEY },
      { mandate: id('another mandate') },
    ]
    for (const change of changes) {
      expect(sellerMandateRevocationHash(withRevocation(change), DOMAIN)).not.toBe(hash)
    }
    expect(
      sellerMandateRevocationHash(revocation, { ...DOMAIN, verifyingContract: OTHER_LOCK }),
    ).not.toBe(hash)
    expect(sellerMandateRevocationHash(revocation, { ...DOMAIN, chainId: CHAIN_ID + 1 })).not.toBe(
      hash,
    )
    expect(SELLER_MANDATE_REVOCATION_TYPES.SellerMandateRevocation.map((f) => f.name)).toEqual(
      Object.keys(revocation),
    )
  })

  it('signs to one fixed digest, so a change to the signed form is noticed', () => {
    const fixed: SellerMandateRevocation = {
      businessId: 'biz_supplier',
      account: '0x00000000000000000000000000000000000a11ce',
      signingKey: KEY,
      mandate: `0x${'5a'.repeat(32)}`,
    }
    expect(sellerMandateRevocationHash(fixed, DOMAIN)).toMatchInlineSnapshot(
      `"0x984f28e2563847193909e4547f1065ca2b08c75f6767c186547b1dac55588e21"`,
    )
  })
})

describe('what a revocation names', () => {
  it('names the mandate whose hash, business, account and key it carries', () => {
    expect(revokesSellerMandate(revocation, mandate, DOMAIN)).toBe(true)
  })

  it('names no other mandate, and none under another lock', () => {
    const other: SellerMandate = { ...mandate, mandateId: id('another') }
    expect(revokesSellerMandate(revocation, other, DOMAIN)).toBe(false)
    expect(
      revokesSellerMandate(revocation, mandate, { ...DOMAIN, verifyingContract: OTHER_LOCK }),
    ).toBe(false)
    // The hash is the mandate's, and a field beside it says another agent's.
    expect(revokesSellerMandate(withRevocation({ signingKey: OTHER_KEY }), mandate, DOMAIN)).toBe(
      false,
    )
    expect(revokesSellerMandate(withRevocation({ businessId: 'biz_other' }), mandate, DOMAIN)).toBe(
      false,
    )
    expect(revokesSellerMandate(withRevocation({ account: OTHER_KEY }), mandate, DOMAIN)).toBe(
      false,
    )
    expect(revokesSellerMandate({ ...revocation, extra: 1 } as never, mandate, DOMAIN)).toBe(false)
  })
})

describe("a revocation's signature", () => {
  const expected = { domain: DOMAIN, account: ACCOUNT }

  it("passes for the business account's own", async () => {
    expect(await sellerMandateRevocationSignatureProblem(await signed(), expected)).toBeNull()
  })

  it('fails for anyone else, another account, another lock or a changed field', async () => {
    const invalid = 'message.signature_invalid'
    const problem = sellerMandateRevocationSignatureProblem
    expect(await problem(await signed(revocation, stranger), expected)).toBe(invalid)
    // The stranger revokes under its own account's name.
    const theirs = withRevocation({ account: stranger.address.toLowerCase() as Address })
    expect(await problem(await signed(theirs, stranger), expected)).toBe(invalid)
    expect(
      await problem(await signed(), {
        ...expected,
        domain: { ...DOMAIN, verifyingContract: OTHER_LOCK },
      }),
    ).toBe(invalid)
    const sound = await signed()
    const changed = { ...sound, message: withRevocation({ mandate: id('another mandate') }) }
    expect(await problem(changed, expected)).toBe(invalid)
    const malformed = { ...sound, message: withRevocation({ mandate: '0x12' }) }
    expect(await problem(malformed, expected)).toBe('message.invalid')
  })
})

describe('reading a revocation from JSON', () => {
  const where = { chainId: CHAIN_ID, lock: LOCK }
  const wire = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
  const reason = (json: unknown) => {
    const read = parseSellerMandateRevocation(json, where)
    return read.ok ? null : read.reason
  }

  it('reads back as it was written', async () => {
    const sound = await signed()
    expect(parseSellerMandateRevocation(wire(sound), where)).toEqual({ ok: true, value: sound })
  })

  it("refuses another chain, lock, type or version, and a field it doesn't know", async () => {
    const json = wire(await signed())
    expect(reason({ ...json, chainId: CHAIN_ID + 1 })).toBe('message.wrong_chain')
    expect(reason({ ...json, lock: OTHER_LOCK })).toBe('message.wrong_contract')
    expect(reason({ ...json, type: 'SellerMandate' })).toBe('message.schema_unknown')
    expect(reason({ ...json, schemaVersion: '2' })).toBe('message.schema_unknown')
    expect(reason({ ...json, message: { ...json.message, revokedAt: '1' } })).toBe(
      'message.invalid',
    )
    expect(reason({ ...json, message: { ...json.message, mandate: `0x${'0'.repeat(64)}` } })).toBe(
      'message.invalid',
    )
  })
})
