import { type Address, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { digestOf, type Signed } from './eip712.js'
import {
  parseSellerKeyRevocation,
  revokesSellerKey,
  SELLER_KEY_REVOCATION_TYPES,
  type SellerKeyRevocation,
  sellerKeyRevocationHash,
  sellerKeyRevocationProblem,
  sellerKeyRevocationSignatureProblem,
  sellerKeyRevocationTypedData,
} from './seller-key-revocation.js'
import { CHAIN_ID, DOMAIN, demoSellerMandate, LOCK, newKey, OTHER_LOCK } from './test-helpers.js'
import { MESSAGE_VERSIONS } from './version.js'
import { toWire } from './wire.js'

const admin = newKey()
const stranger = newKey()
const ACCOUNT = admin.address.toLowerCase() as Address
const KEY: Address = '0x0000000000000000000000000000000000005e11'
const OTHER_KEY: Address = '0x0000000000000000000000000000000000005e12'

const revocation: SellerKeyRevocation = {
  businessId: 'biz_supplier',
  account: ACCOUNT,
  signingKey: KEY,
}
const withRevocation = (change: Partial<SellerKeyRevocation>) => ({ ...revocation, ...change })
const signed = async (r = revocation, by = admin): Promise<Signed<SellerKeyRevocation>> => ({
  type: 'SellerKeyRevocation',
  schemaVersion: MESSAGE_VERSIONS.SellerKeyRevocation,
  chainId: CHAIN_ID,
  lock: LOCK,
  message: r,
  signature: await by.sign({ hash: digestOf(sellerKeyRevocationTypedData(r, DOMAIN)) }),
})

describe("a selling agent's key revocation", () => {
  it('is well formed with its three fields, and addresses in lower case', () => {
    expect(sellerKeyRevocationProblem(revocation)).toBeNull()
  })

  it('is refused with a field missing, added, of the wrong kind or not in lower case', () => {
    const changes: object[] = [
      { businessId: '' },
      { businessId: 7 },
      { businessId: 'a'.repeat(101) },
      { account: admin.address },
      { account: '0x12' },
      { signingKey: getAddress(KEY).replace('5e11', '5E11') },
      { signingKey: null },
      { mandate: `0x${'5a'.repeat(32)}` },
      { revokedAt: 1n },
    ]
    for (const change of changes) {
      const reason = sellerKeyRevocationProblem(withRevocation(change))
      expect(reason, JSON.stringify(toWire(change))).toBe('message.invalid')
    }
    const { signingKey: _, ...missing } = revocation
    expect(sellerKeyRevocationProblem(missing as never)).toBe('message.invalid')
    for (const value of [null, undefined, 'revoked', 7, []]) {
      expect(sellerKeyRevocationProblem(value as never)).toBe('message.invalid')
    }
    const thrower = new Proxy(revocation, {
      get() {
        throw new Error('read')
      },
    })
    expect(sellerKeyRevocationProblem(thrower)).toBe('message.invalid')
  })

  it('signs every field, under the lock and its own version', () => {
    const hash = sellerKeyRevocationHash(revocation, DOMAIN)
    const changes: Partial<SellerKeyRevocation>[] = [
      { businessId: 'biz_other' },
      { account: OTHER_KEY },
      { signingKey: OTHER_KEY },
    ]
    for (const change of changes) {
      expect(sellerKeyRevocationHash(withRevocation(change), DOMAIN)).not.toBe(hash)
    }
    const otherLock = { ...DOMAIN, verifyingContract: OTHER_LOCK }
    expect(sellerKeyRevocationHash(revocation, otherLock)).not.toBe(hash)
    expect(sellerKeyRevocationHash(revocation, { ...DOMAIN, chainId: CHAIN_ID + 1 })).not.toBe(hash)
    expect(SELLER_KEY_REVOCATION_TYPES.SellerKeyRevocation.map((f) => f.name)).toEqual(
      Object.keys(revocation),
    )
  })

  it('signs to one fixed digest, so a change to the signed form is noticed', () => {
    const fixed: SellerKeyRevocation = {
      businessId: 'biz_supplier',
      account: '0x00000000000000000000000000000000000a11ce',
      signingKey: KEY,
    }
    expect(sellerKeyRevocationHash(fixed, DOMAIN)).toMatchInlineSnapshot(
      `"0x1dbd00aa8f4a7c9e6796cd85e4025670ac0e212bb265a90392ef1f334f8ca8df"`,
    )
  })
})

describe('whose authority a revocation ends', () => {
  const agent = { businessId: 'biz_supplier', account: ACCOUNT, signingKey: KEY }

  it("names the agent with its business, account and key, and so every mandate of that agent's", () => {
    expect(revokesSellerKey(revocation, agent)).toBe(true)
    expect(revokesSellerKey(revocation, { ...agent, account: admin.address })).toBe(true)
    expect(revokesSellerKey(revocation, demoSellerMandate(ACCOUNT, KEY))).toBe(true)
  })

  it("names no other business's, account's or key's agent", () => {
    expect(revokesSellerKey(revocation, { ...agent, signingKey: OTHER_KEY })).toBe(false)
    expect(revokesSellerKey(revocation, { ...agent, businessId: 'biz_other' })).toBe(false)
    expect(revokesSellerKey(revocation, { ...agent, account: OTHER_KEY })).toBe(false)
    expect(revokesSellerKey(revocation, demoSellerMandate(ACCOUNT, OTHER_KEY))).toBe(false)
  })

  it("is false, and doesn't throw, for a revocation or an agent that isn't one", () => {
    expect(revokesSellerKey({ ...revocation, extra: 1 } as never, agent)).toBe(false)
    expect(revokesSellerKey(null as never, agent)).toBe(false)
    expect(revokesSellerKey(revocation, null as never)).toBe(false)
    expect(revokesSellerKey(revocation, { ...agent, account: '0x12' })).toBe(false)
    expect(revokesSellerKey(revocation, { ...agent, signingKey: undefined as never })).toBe(false)
  })
})

describe("a revocation's signature", () => {
  const expected = { domain: DOMAIN, businessId: 'biz_supplier', account: ACCOUNT, signingKey: KEY }
  const problem = sellerKeyRevocationSignatureProblem

  it("passes for the business account's own", async () => {
    expect(await problem(await signed(), expected)).toBeNull()
  })

  it('fails for anyone else, or under another lock', async () => {
    const invalid = 'message.signature_invalid'
    expect(await problem(await signed(revocation, stranger), expected)).toBe(invalid)
    const sound = await signed()
    expect(await problem({ ...sound, signature: '0x' }, expected)).toBe(invalid)
    const otherLock = { ...expected, domain: { ...DOMAIN, verifyingContract: OTHER_LOCK } }
    expect(await problem(sound, otherLock)).toBe('message.wrong_contract')
    // Signed for another lock and moved into this lock's envelope.
    const elsewhere = await admin.sign({
      hash: digestOf(sellerKeyRevocationTypedData(revocation, otherLock.domain)),
    })
    expect(await problem({ ...sound, signature: elsewhere }, expected)).toBe(invalid)
  })

  it('refuses one for another agent, another kind of message, or no revocation at all', async () => {
    // The stranger revokes under its own account's name.
    const theirs = withRevocation({ account: stranger.address.toLowerCase() as Address })
    expect(await problem(await signed(theirs, stranger), expected)).toBe('message.invalid')
    expect(await problem(await signed(withRevocation({ signingKey: OTHER_KEY })), expected)).toBe(
      'message.invalid',
    )
    const sound = await signed()
    expect(await problem({ ...sound, type: 'SellerMandate' }, expected)).toBe(
      'message.schema_unknown',
    )
    expect(await problem({ ...sound, message: null as never }, expected)).toBe('message.invalid')
    expect(await problem(null as never, expected)).toBe('message.invalid')
  })
})

describe('reading a revocation from JSON', () => {
  const where = { chainId: CHAIN_ID, lock: LOCK }
  const wire = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
  const reason = (json: unknown) => {
    const read = parseSellerKeyRevocation(json, where)
    return read.ok ? null : read.reason
  }

  it('reads back as it was written', async () => {
    const sound = await signed()
    expect(parseSellerKeyRevocation(wire(sound), where)).toEqual({ ok: true, value: sound })
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
    expect(reason({ ...json, message: { ...json.message, businessId: '' } })).toBe(
      'message.invalid',
    )
  })
})
