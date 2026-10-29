import type { Address, Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account, P256 } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { testnetDemoTerms } from './demo.js'
import { digestOf, type TermsAgreement, termsAgreementTypedData } from './eip712.js'
import { isKeySignature, wrapKeychainV2 } from './keychain.js'
import {
  type AgreementOffer,
  parseAgreementOffer,
  parseAgreementSignature,
  parseSupplierProfile,
  parseSupplierRefusal,
  SUPPLIER_ADAPTER_PATHS,
} from './supplier-adapter.js'
import { termsHash } from './terms.js'
import { ARBITER, DOMAIN, id, NOW, START } from './test-helpers.js'
import { toWire } from './wire.js'

// Every key is generated for the run and held only in memory.
const SALT: Hex = `0x${'55'.repeat(32)}`
const terms = testnetDemoTerms(START, ARBITER)
const agreement: TermsAgreement = {
  commitmentId: id('commitment-1'),
  termsHash: termsHash(terms, SALT),
  category: 'compute',
  buyerBusinessId: 'biz_buyer',
  supplierBusinessId: 'biz_supplier',
  mandateHash: id('mandate'),
  nonce: 9n,
  expiry: NOW + 600n,
}
const offer: AgreementOffer = { agreement, terms, salt: SALT, domain: DOMAIN }
/** A value as it arrives over HTTP: through `toWire` and JSON. */
const wire = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))
const digest = digestOf(termsAgreementTypedData(agreement, DOMAIN))

/** One signing key of each kind Tempo reads for a single key. */
const signingKeys = {
  secp256k1: () => Account.fromSecp256k1(generatePrivateKey()),
  'P-256': () => Account.fromP256(P256.randomPrivateKey()),
  WebAuthn: () =>
    Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), {
      rpId: 'avow.finance',
      origin: 'https://avow.finance',
    }),
}

describe("a supplier adapter's routes and bodies", () => {
  it('names the two routes an agent calls', () => {
    expect(SUPPLIER_ADAPTER_PATHS).toEqual({ profile: '/profile', agreements: '/agreements' })
  })

  it('reads an offer as the SDK sends it, and refuses anything else', () => {
    expect(parseAgreementOffer(wire(offer))).toEqual({ ok: true, value: offer })
    const refused = [
      { ...wire(offer), extra: true },
      { ...wire(offer), salt: '0x1234' },
      { ...wire(offer), domain: { ...DOMAIN, chainId: 0 } },
      { ...wire(offer), agreement: { ...wire(agreement), nonce: 9 } },
      { agreement: wire(agreement), terms: wire(terms), salt: SALT },
      'an offer',
    ]
    for (const body of refused) {
      expect(parseAgreementOffer(body)).toEqual({ ok: false, reason: 'message.invalid' })
    }
    // Terms that don't parse carry the reason the terms parser gives.
    expect(parseAgreementOffer({ ...wire(offer), terms: { ...wire(terms), version: 3 } })).toEqual({
      ok: false,
      reason: 'terms.version_unknown',
    })
  })

  for (const [kind, make] of Object.entries(signingKeys)) {
    it(`takes a ${kind} signature isKeySignature accepts`, async () => {
      const key = make()
      const signature = await key.sign({ hash: digest })
      expect(isKeySignature(digest, signature, key.address as Address)).toBe(true)
      expect(parseAgreementSignature(wire({ signature }))).toEqual({
        ok: true,
        value: { signature: signature.toLowerCase() },
      })
    })
  }

  it("refuses an answer that isn't one key's signature", async () => {
    const key = signingKeys.secp256k1()
    const signature = await key.sign({ hash: digest })
    // A keychain envelope is an account's signature, which isKeySignature refuses too.
    const wrapped = wrapKeychainV2(key.address, signature)
    expect(isKeySignature(digest, wrapped, key.address)).toBe(false)
    expect(parseAgreementSignature({ signature: wrapped })).toEqual({
      ok: false,
      reason: 'message.signature_invalid',
    })
    expect(parseAgreementSignature({ signature: '0x1234' })).toEqual({
      ok: false,
      reason: 'message.signature_invalid',
    })
    for (const body of [{ signature: '0x' }, { signature: 'ab' }, {}, null]) {
      expect(parseAgreementSignature(body)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })

  it("reads a supplier's profile, ignoring fields it doesn't know, and why it refused", () => {
    const profile = {
      businessId: 'biz_supplier',
      account: '0x00000000000000000000000000000000000000C1',
      payee: '0x00000000000000000000000000000000000000C1',
      signingKey: '0x00000000000000000000000000000000000000C3',
    }
    expect(parseSupplierProfile({ ...profile, name: 'A supplier' })).toEqual({
      ok: true,
      value: {
        businessId: 'biz_supplier',
        account: '0x00000000000000000000000000000000000000c1',
        payee: '0x00000000000000000000000000000000000000c1',
        signingKey: '0x00000000000000000000000000000000000000c3',
      },
    })
    expect(parseSupplierProfile({ businessId: 'biz_supplier' })).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseSupplierRefusal({ error: 'the reserve is over its limit' })).toEqual({
      error: 'the reserve is over its limit',
    })
    expect(parseSupplierRefusal({ error: { reason: 'x' } })).toBeNull()
  })
})
