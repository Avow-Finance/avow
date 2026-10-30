import { digestOf, isKeySignature, REPORT_TYPES, reportTypedData } from '@avow-finance/spec'
import { decodeFunctionData, getAbiItem, getAddress, toFunctionSelector } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'
import { type LockedBacking, MemoryChain } from './chain.js'
import { disclosureId, formatTime } from './disclosure.js'
import {
  prepareReport,
  REPORT_ABI,
  REPORT_VALIDITY,
  type ReportDeps,
  type ReportRequest,
  reportCall,
  signReport,
} from './report.js'
import {
  CHAIN_ID,
  COMMITMENT,
  DOMAIN,
  id,
  LOCK,
  LOCK_TERMS,
  lockedBacking,
  lockInfo,
  newKey,
  PAYEE,
  reservedChain,
  supplierKey,
  TOKEN,
} from './test-helpers.js'

let chain: MemoryChain
let deps: ReportDeps

/** Five minutes after free cancellation ended, and before the booked window opens. */
const REPORT_NOW = LOCK_TERMS.freeCancelBy + 300n
const EVIDENCE = id('the note on the late cancellation')
const [LATE, NO_SHOW] = LOCK_TERMS.charges as [
  (typeof LOCK_TERMS.charges)[0],
  (typeof LOCK_TERMS.charges)[0],
]

function setCommitment(change: Partial<LockedBacking>) {
  chain.setBacking(LOCK, COMMITMENT, 'buyer', lockedBacking({ state: 'accepted', ...change }))
}

beforeEach(() => {
  chain = reservedChain()
  setCommitment({})
  deps = {
    config: { chainId: CHAIN_ID, signingKey: supplierKey.address, acceptedTokens: [TOKEN] },
    chain,
  }
})

const refused = (reason: string) => ({ ok: false, reason })

function prepare(change: Partial<ReportRequest> = {}) {
  return prepareReport(
    {
      lock: LOCK,
      commitmentId: COMMITMENT,
      kind: 'lateCancellation',
      evidenceHash: EVIDENCE,
      now: REPORT_NOW,
      nonce: 5n,
      ...change,
    },
    deps,
  )
}

async function ready(change: Partial<ReportRequest> = {}) {
  const prepared = await prepare(change)
  if (!prepared.ok) throw new Error(prepared.reason)
  return prepared
}

describe('a report the lock takes', () => {
  it("charges the kind's most by default, and stays valid for ten minutes", async () => {
    const prepared = await ready()
    expect(prepared.report).toEqual({
      commitmentId: COMMITMENT,
      side: 'buyer',
      kind: 'lateCancellation',
      amount: LATE.most,
      evidenceHash: EVIDENCE,
      nonce: 5n,
      expiry: REPORT_NOW + REPORT_VALIDITY,
    })
    expect(LATE.most).toBe(250_000_000n)
    expect(prepared.digest).toBe(digestOf(reportTypedData(prepared.report, DOMAIN)))
    expect(prepared.signingKey).toBe(supplierKey.address)
  })

  it('charges less when the supplier names less, and a no-show from its earliest', async () => {
    expect((await ready({ amount: 100_000_000n })).report.amount).toBe(100_000_000n)
    const noShow = await ready({ kind: 'noShow', now: NO_SHOW.earliest })
    expect(noShow.report).toMatchObject({ kind: 'noShow', amount: NO_SHOW.most })
    expect((await ready({ now: LATE.earliest })).report.kind).toBe('lateCancellation')
  })

  it('never lets the report outlive the charge deadline', async () => {
    const late = LOCK_TERMS.chargeDeadline - 60n
    expect((await ready({ now: late })).report.expiry).toBe(LOCK_TERMS.chargeDeadline)
  })

  it('takes a second report once the first is withdrawn', async () => {
    setCommitment({ reportCount: 1, hasReport: false })
    expect((await prepare()).ok).toBe(true)
  })
})

describe('signing the report', () => {
  it('signs with the signing key the lock holds once the disclosure is confirmed', async () => {
    const prepared = await ready()
    const signed = await signReport(prepared, supplierKey, {
      disclosureId: prepared.disclosure.id,
    })
    expect(signed).toMatchObject({
      type: 'Report',
      schemaVersion: '1',
      chainId: CHAIN_ID,
      lock: LOCK,
    })
    expect(signed.message).toEqual(prepared.report)
    expect(isKeySignature(prepared.digest, signed.signature, supplierKey.address)).toBe(true)
  })

  it('refuses without the confirmation, or with another disclosure id', async () => {
    const prepared = await ready()
    await expect(
      signReport(prepared, supplierKey, { disclosureId: undefined as never }),
    ).rejects.toThrow(/disclosure/)
    await expect(
      signReport(prepared, supplierKey, { disclosureId: id('another disclosure') }),
    ).rejects.toThrow(/disclosure/)
  })

  it("refuses a key that isn't the signing key the lock holds", async () => {
    const prepared = await ready()
    await expect(
      signReport(prepared, newKey(), { disclosureId: prepared.disclosure.id }),
    ).rejects.toThrow(/signing key/)
  })

  it('refuses a copy or an edit of what prepareReport returned', async () => {
    const prepared = await ready()
    const confirm = { disclosureId: prepared.disclosure.id }
    const notBuilt = /as it returned it/
    const larger = { ...prepared, report: { ...prepared.report, amount: NO_SHOW.most } }
    await expect(signReport(larger, supplierKey, confirm)).rejects.toThrow(notBuilt)
    // A copy with its digest and disclosure rebuilt to match, so it agrees with itself.
    const later = { ...prepared.report, expiry: prepared.report.expiry + 3600n }
    const digest = digestOf(reportTypedData(later, prepared.domain))
    const sections = [{ heading: 'Nothing to see', lines: ['Sign here'] }]
    const rebuilt = {
      ...prepared,
      report: later,
      digest,
      disclosure: {
        ...prepared.disclosure,
        digest,
        sections,
        id: disclosureId({ ...prepared.disclosure, digest, sections }),
      },
    }
    await expect(
      signReport(rebuilt, supplierKey, { disclosureId: rebuilt.disclosure.id }),
    ).rejects.toThrow(notBuilt)
    // The object itself can't be changed in place.
    expect(() => {
      ;(prepared.report as { amount: bigint }).amount = 1n
    }).toThrow(TypeError)
    expect((await signReport(prepared, supplierKey, confirm)).message.amount).toBe(LATE.most)
  })
})

describe('the call that hands a report to the lock', () => {
  it("has the selector of the testnet lock's report", () => {
    expect(toFunctionSelector(getAbiItem({ abi: REPORT_ABI, name: 'report' }))).toBe(
      toFunctionSelector('report((bytes32,uint8,uint8,uint256,bytes32,uint256,uint64),bytes)'),
    )
  })

  it('takes its fields from the report type the signature covers', () => {
    expect(REPORT_ABI[0].inputs[0].components).toBe(REPORT_TYPES.Report)
  })

  it('carries the report to its lock exactly as it was signed', async () => {
    const prepared = await ready({ kind: 'noShow', now: NO_SHOW.earliest, amount: 400_000_000n })
    const signed = await signReport(prepared, supplierKey, {
      disclosureId: prepared.disclosure.id,
    })
    const call = reportCall(signed)
    expect(call.to).toBe(LOCK)
    const { args } = decodeFunctionData({ abi: REPORT_ABI, data: call.data })
    const [message, signature] = args
    expect(signature).toBe(signed.signature)
    // The buyer's side and the no-show go as the codes the lock files them under.
    expect(message).toEqual({ ...prepared.report, side: 0, kind: 1 })
  })
})

describe('what the lock would never take', () => {
  it("refuses a lock Avow's factory didn't make, a missing commitment and another supplier's", async () => {
    setCommitment({ supplierSigner: newKey().address })
    expect(await prepare()).toEqual(refused('chain.supplier_mismatch'))
    chain.setBacking(LOCK, COMMITMENT, 'buyer', null)
    expect(await prepare()).toEqual(refused('chain.reserve_missing'))
    chain.setLock(LOCK, lockInfo({ fromFactory: false }))
    expect(await prepare()).toEqual(refused('chain.lock_unknown'))
  })

  it('refuses a commitment the lock holds in any state but accepted', async () => {
    for (const state of [
      'reserved',
      'charge_pending',
      'paused',
      'released',
      'charged',
      'resolved',
    ] as const) {
      setCommitment({ state })
      expect(await prepare(), state).toEqual(refused('report.not_reportable'))
    }
  })

  it('refuses while a report is open, and once two have been filed', async () => {
    setCommitment({ hasReport: true, reportCount: 1 })
    expect(await prepare()).toEqual(refused('report.open'))
    setCommitment({ hasReport: false, reportCount: 2 })
    expect(await prepare()).toEqual(refused('report.limit_reached'))
  })

  it("refuses a kind the commitment's terms don't carry", async () => {
    setCommitment({ charges: [LATE] })
    expect(await prepare({ kind: 'noShow', now: NO_SHOW.earliest })).toEqual(
      refused('report.kind_not_allowed'),
    )
  })

  it("refuses an amount of zero or more than the kind's most", async () => {
    for (const amount of [0n, -1n, LATE.most + 1n]) {
      expect(await prepare({ amount }), String(amount)).toEqual(refused('report.amount_invalid'))
    }
  })

  it("refuses a report before its kind's earliest, and from the charge deadline on", async () => {
    expect(await prepare({ now: LATE.earliest - 1n })).toEqual(refused('report.too_early'))
    expect(await prepare({ kind: 'noShow', now: NO_SHOW.earliest - 1n })).toEqual(
      refused('report.too_early'),
    )
    expect(await prepare({ now: LOCK_TERMS.chargeDeadline })).toEqual(refused('commitment.ended'))
  })

  it('refuses a kind, commitment, evidence hash or amount the lock has no place for', async () => {
    for (const change of [
      { kind: 'cleaning' },
      { kind: 'toString' },
      { commitmentId: '0x1234' },
      { evidenceHash: '0x1234' },
      { amount: 5 },
    ] as Partial<ReportRequest>[]) {
      expect(await prepare(change), JSON.stringify(change)).toEqual(refused('message.invalid'))
    }
  })

  it('throws on a chain reader for another chain', async () => {
    deps = { ...deps, chain: new MemoryChain(1) }
    await expect(prepare()).rejects.toThrow('for chain 1')
  })
})

describe('the disclosure', () => {
  it('shows the charge, who it pays, what Avow does next and when the report stops working', async () => {
    const { disclosure } = await ready()
    expect(disclosure.title).toBe('Report a charge')
    expect(disclosure.sections.map((s) => s.heading)).toEqual([
      "What you're reporting",
      'What happens next',
      'Reports',
      'Expiry',
    ])
    const text = disclosure.sections.flatMap((s) => s.lines).join('\n')
    for (const expected of [
      `You report a late cancellation on commitment ${COMMITMENT} on lock ${getAddress(LOCK)}, chain ${CHAIN_ID}`,
      'It charges USD 250 (250000000 base units',
      `paid to ${getAddress(PAYEE)}`,
      `the evidence with hash ${EVIDENCE}`,
      'within 5 minutes of the first report of its kind on this commitment',
      'the lock keeps only the charge and gives the rest of the reserve back to the business',
      'once its contest window of 10 minutes closes',
      "contest a report Avow hasn't confirmed at any time",
      'still unruled 90 minutes after its pause pays you 50% of it if Avow confirmed it',
      'This is report 1 of the two the commitment takes',
      "Your supplier account's root key can withdraw it",
      `It stops working at ${formatTime(REPORT_NOW + REPORT_VALIDITY)}`,
      `the lock takes no report from ${formatTime(LOCK_TERMS.chargeDeadline)}`,
    ]) {
      expect(text).toContain(expected)
    }
    expect(disclosure.preauthorization).toBeNull()
    expect(disclosure.digest).toBe((await ready()).digest)
  })

  it("names the second report, and shows base units of a token the supplier doesn't list", async () => {
    setCommitment({ reportCount: 1 })
    deps = { ...deps, config: { ...deps.config, acceptedTokens: [] } }
    const text = (await ready()).disclosure.sections.flatMap((s) => s.lines).join('\n')
    expect(text).toContain('This is report 2 of the two')
    expect(text).toContain("It charges 250000000 base units of the lock's token")
  })
})
