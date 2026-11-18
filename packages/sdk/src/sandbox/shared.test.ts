import {
  type CommitmentReference,
  encodeCommitmentReference,
  type RailState,
  TESTNET_DEMO_PROFILE,
} from '@avow-finance/spec'
import { type LockedBacking, MemoryChain } from '@avow-finance/verifier'
import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { checkShared, sharedJson, sharedSentences, sharedToken } from './shared.js'

const CHAIN_ID = 42431
const LOCK: Address = '0x10ca000000000000000000000000000000000001'
const BUSINESS: Address = '0xb000000000000000000000000000000000000001'
const SUPPLIER: Address = '0x5000000000000000000000000000000000000001'
const PAYEE: Address = '0x5000000000000000000000000000000000000002'
const TOKEN: Address = '0x20c00000000000000000000058fbf8a39a171185'
const TERMS: Hex = `0x${'ab'.repeat(32)}`

const reference: CommitmentReference = {
  kind: 'commitment',
  chainId: CHAIN_ID,
  lock: LOCK,
  commitmentId: `0x${'01'.repeat(32)}`,
  side: 'buyer',
  termsHash: TERMS,
}

function backing(state: RailState = 'reserved'): LockedBacking {
  return {
    state,
    token: TOKEN,
    amount: 200_000_000n,
    held: 200_000_000n,
    payee: PAYEE,
    supplier: SUPPLIER,
    supplierSigner: SUPPLIER,
    freeCancelBy: 1_800_003_600n,
    acceptBy: 1_800_000_600n,
    chargeDeadline: 1_800_090_000n,
    contestWindow: 259_200n,
    releaseDate: 1_800_100_000n,
    charges: [{ kind: 'noShow', most: 200_000_000n, earliest: 1_800_003_600n }],
    day90SupplierShareBps: 5000,
    arbiter: SUPPLIER,
    termsHash: TERMS,
    mandateHash: `0x${'cd'.repeat(32)}`,
    approvalHash: `0x${'ef'.repeat(32)}`,
    fundingKey: BUSINESS,
    reportCount: 0,
    reportKind: null,
    reportAmount: 0n,
    hasReport: false,
    contested: false,
    chargeStart: 0n,
    pausedAt: 0n,
    hasRuling: false,
  }
}

/** A chain whose factory made the lock, holding the commitment as `held` says. */
function chainWith(held: LockedBacking | null, fromFactory = true) {
  const chain = new MemoryChain(CHAIN_ID)
  chain.setLock(LOCK, {
    fromFactory,
    account: BUSINESS,
    token: TOKEN,
    timing: TESTNET_DEMO_PROFILE.lockTiming,
  })
  chain.setBacking(LOCK, reference.commitmentId, 'buyer', held)
  return (chainId: number) => (chainId === CHAIN_ID ? chain : null)
}

const link = `https://try.testnet.avow.finance/#verify=${encodeCommitmentReference(reference)}`

describe('checking a commitment someone shared', () => {
  it('reads the token from a whole link or alone', () => {
    const token = encodeCommitmentReference(reference)
    expect(sharedToken(link)).toBe(token)
    expect(sharedToken(` ${token} `)).toBe(token)
  })

  it('says what the lock holds, and whether it pays the address given', async () => {
    const chain = chainWith(backing())
    const mine = await checkShared({ link, payee: PAYEE }, { chain })
    expect(mine).toMatchObject({
      standing: true,
      state: 'reserved',
      business: BUSINESS,
      reserved: 200_000_000n,
      held: 200_000_000n,
      payee: PAYEE,
      paysYou: true,
    })
    expect(sharedJson(mine)).toMatchObject({ standing: true, reserved: 200, held: 200 })
    expect(sharedSentences(mine).join(' ')).toMatch(/holds \$200 of a \$200 reserve/)
    expect(sharedSentences(mine).join(' ')).toMatch(/waiting for the supplier to accept/)

    const theirs = await checkShared({ link, payee: SUPPLIER }, { chain })
    expect(theirs).toMatchObject({ standing: true, paysYou: false })
    expect(sharedSentences(theirs).join(' ')).toMatch(/isn't to you/)
    expect(await checkShared({ link }, { chain })).toMatchObject({ paysYou: null })
  })

  it("refuses a link that doesn't read, a lock the factory didn't make, and other terms", async () => {
    expect(
      await checkShared({ link: 'not a link' }, { chain: chainWith(backing()) }),
    ).toMatchObject({ standing: false, reason: 'message.invalid' })
    expect(await checkShared({ link }, { chain: chainWith(backing(), false) })).toMatchObject({
      standing: false,
      reason: 'chain.lock_unknown',
    })
    const other = { ...backing(), termsHash: `0x${'99'.repeat(32)}` as Hex }
    expect(await checkShared({ link }, { chain: chainWith(other) })).toMatchObject({
      standing: false,
      reason: 'reference.commitment_mismatch',
    })
    expect(await checkShared({ link }, { chain: chainWith(null) })).toMatchObject({
      standing: false,
      reason: 'reference.commitment_mismatch',
    })
    // A chain this SDK trusts no factory on is never read.
    const elsewhere = `#verify=${encodeCommitmentReference({ ...reference, chainId: 1 })}`
    expect(await checkShared({ link: elsewhere }, { chain: chainWith(backing()) })).toMatchObject({
      standing: false,
      reason: 'message.wrong_chain',
    })
  })

  it('says how a commitment ended', async () => {
    const ended = await checkShared({ link }, { chain: chainWith(backing('released')) })
    expect(sharedSentences(ended).join(' ')).toMatch(/went back to the business/)
    expect(sharedSentences(ended).join(' ')).not.toMatch(/Free cancellation/)
  })
})
