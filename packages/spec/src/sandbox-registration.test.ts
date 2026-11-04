import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { isKeySignature } from './keychain.js'
import {
  businessRegistrationBody,
  registrationDigest,
  registrationDomain,
  SANDBOX_ENVIRONMENT,
  signBusinessRegistration,
} from './sandbox-registration.js'

const FACTORY = '0x8fa7177c84be069df2a51f096ed28d5d661b8283'
const domain = registrationDomain(42431, FACTORY)

describe('the sandbox registration', () => {
  it('keeps the digests every signed registration so far was checked against', () => {
    // These digests are the ones Avow's API has checked every registration against, so a change to
    // the domain, the types or their order fails here before any signature stops verifying.
    const business = {
      environment: SANDBOX_ENVIRONMENT,
      audience: 'https://api.testnet.avow.finance',
      account: '0x00000000000000000000000000000000000000a1',
      lock: '0x00000000000000000000000000000000000000b2',
      legalName: 'Playground Test Co',
      country: 'JP',
      nonce: `0x${'11'.repeat(32)}`,
      expiry: 1_800_000_000n,
    } as const
    const supplier = {
      environment: SANDBOX_ENVIRONMENT,
      audience: 'https://api.testnet.avow.finance',
      account: '0x00000000000000000000000000000000000000a1',
      payee: '0x00000000000000000000000000000000000000c3',
      signingKey: '0x00000000000000000000000000000000000000d4',
      nonce: `0x${'22'.repeat(32)}`,
      expiry: 1_800_000_000n,
    } as const
    expect(registrationDigest(domain, { kind: 'business', registration: business })).toBe(
      '0x0ccd882a545f6366b5eb5f0171e368f9ecfa591cdb8d40df373aa9391f1eabed',
    )
    expect(registrationDigest(domain, { kind: 'supplier', registration: supplier })).toBe(
      '0x624f8c9bb99f13d53b94f9ab18fadc01ed1bd98ef4ae5dedc51f7ade35f7f7f5',
    )
  })

  it("signs a business's registration with its root key, in the body the API reads", async () => {
    const root = privateKeyToAccount(generatePrivateKey())
    const lock = '0x00000000000000000000000000000000000000b2'
    const body = await signBusinessRegistration({
      chainId: 42431,
      factory: FACTORY,
      audience: 'https://api.testnet.avow.finance',
      account: root.address,
      lock,
      legalName: 'Playground Test Co',
      country: 'JP',
      now: 1_800_000_000n,
      validity: 120n,
      rootKey: root,
    })
    expect(body.registration).toMatchObject({
      environment: 'sandbox',
      account: root.address,
      lock,
      expiry: 1_800_000_120n,
    })
    expect(body.registration.nonce).toMatch(/^0x[0-9a-f]{64}$/)
    const digest = registrationDigest(domain, { kind: 'business', registration: body.registration })
    expect(isKeySignature(digest, body.accountSignature, root.address)).toBe(true)
    // On the wire every bigint is a decimal string, as the request's canonical JSON writes it.
    const wire = JSON.parse(
      JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    )
    expect(businessRegistrationBody.safeParse(wire).success).toBe(true)
  })

  it('makes a fresh nonce for every registration', async () => {
    const root = privateKeyToAccount(generatePrivateKey())
    const sign = () =>
      signBusinessRegistration({
        chainId: 42431,
        factory: FACTORY,
        audience: 'https://api.testnet.avow.finance',
        account: root.address,
        lock: '0x00000000000000000000000000000000000000b2',
        legalName: 'Playground Test Co',
        country: 'JP',
        now: 1_800_000_000n,
        validity: 120n,
        rootKey: root,
      })
    expect((await sign()).registration.nonce).not.toBe((await sign()).registration.nonce)
  })
})
