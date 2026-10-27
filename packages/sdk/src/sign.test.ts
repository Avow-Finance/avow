import {
  type AvowDomain,
  dollars,
  type HumanApproval,
  humanApprovalTypedData,
  isSignedBy,
  keychainSignatureCheck,
  type Mandate,
  mandateTypedData,
} from '@avow-finance/spec'
import { P256 } from 'ox'
import { type Address, hashTypedData, keccak256, stringToHex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { accountSigner, signHumanApproval, signMandate } from './sign.js'

// Every key is generated for the run and held only in memory.
const id = (label: string) => keccak256(stringToHex(label))
const LOCK: Address = '0x00000000000000000000000000000000000010c4'
const DOMAIN: AvowDomain = { chainId: 42431, verifyingContract: LOCK }
const keychain = keychainSignatureCheck(() => false)

function passkeyBusiness() {
  // A headless stand-in for a browser passkey, as in step 1.35. Step 3.16 runs a real one.
  const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), {
    rpId: 'avow.finance',
    origin: 'https://avow.finance',
  })
  return { root, account: root.address as Address }
}

function mandateFor(account: Address): Mandate {
  return {
    mandateId: id('mandate-1'),
    businessId: 'biz_buyer',
    agentId: 'agt_1',
    account,
    agentKey: Account.fromSecp256k1(generatePrivateKey()).address,
    actions: ['reserve'],
    currency: 'USD',
    capPerCommitment: dollars(1000),
    capOpenReserves: dollars(2000),
    suppliers: ['biz_supplier'],
    categories: [],
    paymentLimits: [
      { token: '0x20c0000000000000000000000000000000000001', amount: dollars(5000), period: 0n },
    ],
    approvalRule: { kind: 'always' },
    expiry: 1_900_000_000n,
    nonce: 1n,
  }
}

describe('signing for a business account', () => {
  it('wraps a passkey root signature in the keychain V2 envelope', async () => {
    const { root, account } = passkeyBusiness()
    const signed = await signMandate(mandateFor(account), DOMAIN, accountSigner(account, root))
    const td = mandateTypedData(signed.message, DOMAIN)
    expect(await isSignedBy(td, signed.signature, account, keychain)).toBe(true)
    expect(signed.signature.slice(0, 4)).toBe('0x04')
  })

  it('works the same for a secp256k1 root', async () => {
    const root = Account.fromSecp256k1(generatePrivateKey())
    const account = root.address as Address
    const signed = await signMandate(mandateFor(account), DOMAIN, accountSigner(account, root))
    const td = mandateTypedData(signed.message, DOMAIN)
    expect(await isSignedBy(td, signed.signature, account, keychain)).toBe(true)
  })

  it('produces nothing the keychain accepts when the key signs bare', async () => {
    const { root, account } = passkeyBusiness()
    const td = mandateTypedData(mandateFor(account), DOMAIN)
    const bare = await root.sign({ hash: hashTypedData(td) })
    expect(await isSignedBy(td, bare, account, keychain)).toBe(false)
  })

  it("refuses to sign a mandate for another business's account", async () => {
    const { root, account } = passkeyBusiness()
    const other = passkeyBusiness().account
    await expect(
      signMandate(mandateFor(other), DOMAIN, accountSigner(account, root)),
    ).rejects.toThrow()
  })

  it('signs a human approval that fails on another chain or lock', async () => {
    const { root, account } = passkeyBusiness()
    const approval: HumanApproval = {
      mandateHash: id('mandate'),
      commitmentId: id('commitment-1'),
      termsHash: id('terms'),
      supplier: 'biz_supplier',
      payee: '0x000000000000000000000000000000000000beef',
      amount: dollars(500),
      nonce: 1n,
      expiry: 1_900_000_000n,
    }
    const signed = await signHumanApproval(approval, DOMAIN, accountSigner(account, root))
    expect(signed).toMatchObject({ type: 'HumanApproval', chainId: 42431, lock: LOCK })
    const here = humanApprovalTypedData(approval, DOMAIN)
    const otherChain = humanApprovalTypedData(approval, { ...DOMAIN, chainId: 1 })
    const otherLock = humanApprovalTypedData(approval, {
      ...DOMAIN,
      verifyingContract: '0x00000000000000000000000000000000000010c5',
    })
    expect(await isSignedBy(here, signed.signature, account, keychain)).toBe(true)
    expect(await isSignedBy(otherChain, signed.signature, account, keychain)).toBe(false)
    expect(await isSignedBy(otherLock, signed.signature, account, keychain)).toBe(false)
  })
})
