import { P256 } from 'ox'
import { type Address, type Hex, isAddressEqual, keccak256, stringToHex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { approvalTypedData, digestOf } from './eip712.js'
import {
  keychainSignatureCheck,
  keychainV2Hash,
  readKeychainEnvelope,
  signForAccount,
  wrapKeychainV2,
} from './keychain.js'

// Every key is generated for the run and held only in memory.
const WEBAUTHN = { rpId: 'avow.finance', origin: 'https://avow.finance' }
const digest = keccak256(stringToHex('a message the lock checks'))
const otherDigest = keccak256(stringToHex('the same message for another chain or lock'))

function secpRoot() {
  const pk = generatePrivateKey()
  const root = Account.fromSecp256k1(pk)
  return { pk, root, account: root.address as Address }
}

function passkeyRoot() {
  const pk = P256.randomPrivateKey()
  const root = Account.fromHeadlessWebAuthn(pk, WEBAUTHN)
  return { pk, root, account: root.address as Address }
}

const noAdmins = keychainSignatureCheck(() => false)

describe('keychainV2Hash and signForAccount', () => {
  it('build the same bytes as viem when a secp256k1 root signs for its account', async () => {
    const { pk, root, account } = secpRoot()
    const viemWrapped = await Account.fromSecp256k1(pk, { access: account }).sign({ hash: digest })
    expect(await signForAccount(account, digest, root)).toBe(viemWrapped)
  })

  it('build an envelope viem reads back as keychain V2 for the account', async () => {
    const { root, account } = passkeyRoot()
    const sig = await signForAccount(account, digest, root)
    const envelope = readKeychainEnvelope(sig)
    expect(envelope?.version).toBe('v2')
    expect(envelope?.account.toLowerCase()).toBe(account.toLowerCase())
    expect(envelope?.inner.slice(0, 4)).toBe('0x02') // a WebAuthn signature inside
  })

  it('bind the signature to the account', () => {
    const { account } = secpRoot()
    const { account: other } = secpRoot()
    expect(keychainV2Hash(digest, account)).not.toBe(keychainV2Hash(digest, other))
    expect(keychainV2Hash(digest, account)).not.toBe(digest)
  })
})

describe('the keychain rule, checked without a node', () => {
  for (const [name, make] of [
    ['secp256k1 root', secpRoot],
    ['passkey root', passkeyRoot],
  ] as const) {
    it(`${name}: accepts a wrapped signature and refuses a bare one`, async () => {
      const { root, account } = make()
      expect(
        await noAdmins({
          signer: account,
          digest,
          signature: await signForAccount(account, digest, root),
        }),
      ).toBe(true)
      expect(
        await noAdmins({ signer: account, digest, signature: await root.sign({ hash: digest }) }),
      ).toBe(false)
    })

    it(`${name}: refuses another account, another digest and the legacy V1 envelope`, async () => {
      const { root, account } = make()
      const { account: other } = secpRoot()
      const sig = await signForAccount(account, digest, root)
      expect(await noAdmins({ signer: other, digest, signature: sig })).toBe(false)
      expect(await noAdmins({ signer: account, digest: otherDigest, signature: sig })).toBe(false)
      // An envelope naming another account, with the inner signature made for that account.
      const forOther = await signForAccount(other, digest, root)
      expect(await noAdmins({ signer: account, digest, signature: forOther })).toBe(false)
      // V1 put the bare signature in the envelope, and the chain now refuses it.
      const v1 = wrapKeychainV2(account, await root.sign({ hash: digest })).replace(/^0x04/, '0x03')
      expect(await noAdmins({ signer: account, digest, signature: v1 as Hex })).toBe(false)
    })
  }

  it('accepts an admin key only when the account lists it', async () => {
    const { account } = passkeyRoot()
    const admin = secpRoot().root
    const sig = await signForAccount(account, digest, admin)
    expect(await noAdmins({ signer: account, digest, signature: sig })).toBe(false)
    const listed = keychainSignatureCheck(
      (a, key) => isAddressEqual(a, account) && isAddressEqual(key, admin.address),
    )
    expect(await listed({ signer: account, digest, signature: sig })).toBe(true)
  })

  it('refuses a signature for the same message on another chain or lock', async () => {
    const { root, account } = secpRoot()
    const msg = {
      commitmentId: keccak256(stringToHex('c')),
      side: 'buyer' as const,
      token: '0x20c0000000000000000000000000000000000001' as const,
      amount: 1n,
      payee: account,
      acceptBy: 1n,
      chargeDeadline: 2n,
      contestWindow: 3n,
      releaseDate: 4n,
      termsHash: digest,
      mandateHash: digest,
      capPerCommitment: 1n,
      capOpenReserves: 1n,
      fundingKey: account,
      nonce: 1n,
      expiry: 5n,
    }
    const lock: Address = '0x00000000000000000000000000000000000010c4'
    const here = digestOf(approvalTypedData(msg, { chainId: 42431, verifyingContract: lock }))
    const sig = await signForAccount(account, here, root)
    const elsewhere = [
      digestOf(approvalTypedData(msg, { chainId: 1, verifyingContract: lock })),
      digestOf(
        approvalTypedData(msg, {
          chainId: 42431,
          verifyingContract: '0x00000000000000000000000000000000000010c5',
        }),
      ),
    ]
    expect(await noAdmins({ signer: account, digest: here, signature: sig })).toBe(true)
    for (const d of elsewhere) {
      expect(await noAdmins({ signer: account, digest: d, signature: sig })).toBe(false)
    }
  })

  it('refuses bytes that are no signature at all', async () => {
    const { account } = secpRoot()
    expect(await noAdmins({ signer: account, digest, signature: '0x04' })).toBe(false)
    expect(await noAdmins({ signer: account, digest, signature: '0x' })).toBe(false)
  })
})
