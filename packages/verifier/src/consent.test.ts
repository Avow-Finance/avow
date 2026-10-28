import { digestOf, releaseConsentTypedData } from '@avow-finance/spec'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LockedBacking, MemoryChain } from './chain.js'
import {
  type ConsentDeps,
  prepareReleaseConsent,
  type ReleaseConsentRequest,
  signReleaseConsent,
} from './consent.js'
import { disclosureId, formatTime } from './disclosure.js'
import {
  CHAIN_ID,
  COMMITMENT,
  DOMAIN,
  id,
  LOCK,
  lockedBacking,
  lockInfo,
  NOW,
  newKey,
  reservedChain,
  supplierAccount,
  TOKEN,
} from './test-helpers.js'

let chain: MemoryChain
let deps: ConsentDeps

const EXPIRY = NOW + 3600n
const EVIDENCE = id('the job ran')

function setCommitment(change: Partial<LockedBacking>) {
  chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ state: 'accepted', ...change }))
}

beforeEach(() => {
  chain = reservedChain()
  setCommitment({})
  deps = {
    config: { chainId: CHAIN_ID, account: supplierAccount.address, acceptedTokens: [TOKEN] },
    chain,
  }
})

const refused = (reason: string) => ({ ok: false, reason })

function prepare(change: Partial<ReleaseConsentRequest> = {}) {
  return prepareReleaseConsent(
    {
      lock: LOCK,
      commitmentId: COMMITMENT,
      reason: 'kept',
      evidenceHash: EVIDENCE,
      expiry: EXPIRY,
      now: NOW,
      nonce: 3n,
      ...change,
    },
    deps,
  )
}

async function ready(change: Partial<ReleaseConsentRequest> = {}) {
  const prepared = await prepare(change)
  if (!prepared.ok) throw new Error(prepared.reason)
  return prepared
}

describe('a consent for the commitment as it stands', () => {
  it("names the commitment's current report count by default", async () => {
    setCommitment({ reportCount: 1 })
    const prepared = await ready()
    expect(prepared.consent).toEqual({
      commitmentId: COMMITMENT,
      side: 'buyer',
      reportCount: 1,
      reason: 'kept',
      evidenceHash: EVIDENCE,
      nonce: 3n,
      expiry: EXPIRY,
    })
    expect(prepared.digest).toBe(digestOf(releaseConsentTypedData(prepared.consent, DOMAIN)))
    expect(prepared.disclosure.preauthorization).toBeNull()
  })

  it("is signed by the supplier account's root key once the disclosure is confirmed", async () => {
    const prepared = await ready()
    const signed = await signReleaseConsent(
      prepared,
      supplierAccount,
      { disclosureId: prepared.disclosure.id },
      { chain },
    )
    expect(signed).toMatchObject({ type: 'ReleaseConsent', chainId: CHAIN_ID, lock: LOCK })
    expect(
      await chain.isAccountSignature(supplierAccount.address, prepared.digest, signed.signature),
    ).toBe(true)
  })

  it('takes an admin key the supplier account lists, and refuses any other key', async () => {
    const prepared = await ready()
    const confirm = { disclosureId: prepared.disclosure.id }
    await expect(signReleaseConsent(prepared, newKey(), confirm, { chain })).rejects.toThrow(
      /root key or an admin key/,
    )
    const admin = newKey()
    chain.addAdminKey(supplierAccount.address, admin.address)
    expect((await signReleaseConsent(prepared, admin, confirm, { chain })).signature).toMatch(
      /^0x04/,
    )
  })

  it('refuses to sign without the confirmation, or after the consent changed', async () => {
    const prepared = await ready()
    await expect(
      signReleaseConsent(prepared, supplierAccount, { disclosureId: id('other') }, { chain }),
    ).rejects.toThrow(/disclosure/)
    const changed = { ...prepared, consent: { ...prepared.consent, reportCount: 2 } }
    await expect(
      signReleaseConsent(
        changed,
        supplierAccount,
        { disclosureId: prepared.disclosure.id },
        { chain },
      ),
    ).rejects.toThrow(/as it returned it/)
    // A consent rebuilt for a later count, with its digest and disclosure recomputed to match,
    // would otherwise sign without preauthorize.
    const later = { ...prepared.consent, reportCount: 1 }
    const digest = digestOf(releaseConsentTypedData(later, prepared.domain))
    const disclosure = { ...prepared.disclosure, digest }
    const rebuilt = {
      ...prepared,
      consent: later,
      digest,
      disclosure: { ...disclosure, id: disclosureId(disclosure) },
    }
    await expect(
      signReleaseConsent(
        rebuilt,
        supplierAccount,
        { disclosureId: rebuilt.disclosure.id },
        { chain },
      ),
    ).rejects.toThrow(/as it returned it/)
  })

  it('shows what it releases, the count it names and when it stops working', async () => {
    setCommitment({ held: 250_000_000n })
    const { disclosure } = await ready()
    const text = disclosure.sections.flatMap((s) => s.lines).join('\n')
    expect(text).toContain('USD 250 (250000000 base units')
    expect(text).toContain('You give up any charge on the commitment')
    expect(text).toContain('the commitment was kept')
    expect(text).toContain('report count 0, the count the commitment has now')
    expect(text).toContain('it stops working if another report is filed first')
    expect(text).toContain(`It stops working at ${formatTime(EXPIRY)}`)
  })
})

describe('a consent for a later report count', () => {
  it('is preauthorization, which the disclosure says and the signer has to confirm', async () => {
    const prepared = await ready({ reportCount: 1 })
    expect(prepared.disclosure.preauthorization).toEqual({ currentCount: 0, consentCount: 1 })
    const text = prepared.disclosure.sections.flatMap((s) => s.lines).join('\n')
    expect(text).toContain(
      'It names report count 1, and the commitment has 0, so the lock refuses it now',
    )
    expect(text).toContain("That's preauthorization")
    const confirm = { disclosureId: prepared.disclosure.id }
    await expect(signReleaseConsent(prepared, supplierAccount, confirm, { chain })).rejects.toThrow(
      /preauthorize/,
    )
    await expect(
      signReleaseConsent(prepared, supplierAccount, { ...confirm, preauthorize: false }, { chain }),
    ).rejects.toThrow(/preauthorize/)
    const signed = await signReleaseConsent(
      prepared,
      supplierAccount,
      { ...confirm, preauthorize: true },
      { chain },
    )
    expect(signed.message.reportCount).toBe(1)
  })

  it('gets another disclosure id than a consent for the current count', async () => {
    const now = await ready()
    const later = await ready({ reportCount: 1 })
    expect(later.disclosure.id).not.toBe(now.disclosure.id)
  })
})

describe('what the lock would never take', () => {
  it('refuses a count the commitment has passed or can never reach', async () => {
    setCommitment({ reportCount: 2 })
    expect(await prepare({ reportCount: 1 })).toEqual(refused('consent.count_passed'))
    expect(await prepare({ reportCount: 3 })).toEqual(refused('consent.count_out_of_range'))
    expect(await prepare({ reportCount: -1 })).toEqual(refused('consent.count_out_of_range'))
    expect(await prepare({ reportCount: 1.5 })).toEqual(refused('consent.count_out_of_range'))
  })

  it('refuses a commitment the lock would not release on consent', async () => {
    for (const change of [
      { state: 'reserved' },
      { state: 'released' },
      { state: 'charged' },
      { state: 'resolved' },
      { state: 'paused', hasRuling: true },
    ] as Partial<LockedBacking>[]) {
      setCommitment(change)
      expect(await prepare(), JSON.stringify(change)).toEqual(refused('consent.not_releasable'))
    }
    for (const change of [
      { state: 'charge_pending' },
      { state: 'paused' },
    ] as Partial<LockedBacking>[]) {
      setCommitment(change)
      expect((await prepare()).ok, JSON.stringify(change)).toBe(true)
    }
  })

  it("refuses another supplier's commitment, a missing one, or a lock Avow's factory didn't make", async () => {
    setCommitment({ supplier: newKey().address })
    expect(await prepare()).toEqual(refused('chain.supplier_mismatch'))
    chain.setBacking(LOCK, COMMITMENT, 'buyer', null)
    expect(await prepare()).toEqual(refused('chain.reserve_missing'))
    chain.setLock(LOCK, lockInfo({ fromFactory: false }))
    expect(await prepare()).toEqual(refused('chain.lock_unknown'))
  })

  it('refuses a reason or an evidence hash the lock has no place for', async () => {
    expect(await prepare({ reason: 'whatever' as never })).toEqual(refused('message.invalid'))
    expect(await prepare({ reason: 'toString' as never })).toEqual(refused('message.invalid'))
    expect(await prepare({ evidenceHash: '0x1234' })).toEqual(refused('message.invalid'))
  })

  it('refuses a consent that has already expired', async () => {
    expect(await prepare({ expiry: NOW })).toEqual(refused('message.expired'))
  })
})
