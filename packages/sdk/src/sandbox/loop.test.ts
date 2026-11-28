import type { CommitmentReference, Mandate } from '@avow-finance/spec'
import type { LockedBacking } from '@avow-finance/verifier'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { AvowApiError } from '../http.js'
import type { SandboxCommitment, SandboxPreflight } from './agent.js'
import type { LateChargeReport } from './late-charge.js'
import { type LoopDeps, type LoopStep, LoopStopped, runLoop } from './loop.js'

const SUPPLIER = 'avow-demo-gpu'
const MANDATE_HASH = `0x${'4d'.repeat(32)}` as Hex
const START = 1_800_000_000n
const idOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const passes: SandboxPreflight = {
  passes: true,
  amounts: {
    needed: 10_000_000n,
    left: 500_000_000n,
    authority: 500_000_000n,
    capPerCommitment: 100_000_000n,
    dailyLimit: null,
    dailyLeft: null,
  },
}

/** A world where the agent books, Avow records and the lock moves on a clock the test drives. */
function world(
  o: {
    actions?: Mandate['actions']
    suppliers?: readonly string[]
    check?: SandboxPreflight
    left?: number
    dailyLeft?: number | null
    cancel?: (id: Hex, attempt: number) => Promise<{ cancelledAt: bigint }>
    confirms?: boolean
    releases?: boolean
    acceptDelay?: bigint
  } = {},
) {
  let now = START
  let booked = 0
  let cancelAttempts = 0
  const steps: LoopStep[] = []
  const asked: { id: Hex; mandate: Mandate }[] = []
  const times = new Map<Hex, { freeCancelBy: bigint; releaseDate: bigint }>()
  let reportedAt: bigint | null = null
  const mandate = {
    message: { actions: o.actions ?? ['reserve', 'cancel', 'start'], agentKey: '0x1' },
  } as unknown as SandboxCommitment['commitment'] & { message: Mandate }

  const book = async (): Promise<SandboxCommitment> => {
    booked++
    const id = idOf(booked)
    const freeCancelBy = now + 120n
    const noShowFrom = now + 360n
    const releaseDate = now + 480n
    times.set(id, { freeCancelBy, releaseDate })
    const reference = { commitmentId: id } as CommitmentReference
    return {
      reference,
      link: `https://try.testnet.avow.finance/#verify=${booked}`,
      amount: 10,
      left: 490,
      commitment: {
        terms: {
          remedies: {
            freeCancelBy,
            charges: [{ kind: 'noShow', amount: 10_000_000n, earliest: noShowFrom }],
            chargeDeadline: releaseDate,
          },
          backing: { amount: 10_000_000n, releaseDate },
          resolution: { contestWindow: 600n },
        },
        agreement: { message: { mandateHash: MANDATE_HASH } },
      },
      verify: async () => [],
      accepted: async () => {
        now += o.acceptDelay ?? 0n
        return true
      },
    } as unknown as SandboxCommitment
  }

  const backing = async (id: Hex): Promise<LockedBacking | null> => {
    const t = times.get(id)
    if (!t) return null
    const base = { hasReport: false, chargeStart: 0n } as LockedBacking
    if (id === idOf(1)) {
      if (reportedAt === null) return { ...base, state: 'accepted' }
      if (o.confirms === false || now < reportedAt + 60n) {
        return { ...base, state: 'accepted', hasReport: true }
      }
      return { ...base, state: 'charge_pending', chargeStart: reportedAt + 60n }
    }
    const released = o.releases !== false && now >= t.releaseDate + 20n
    return { ...base, state: released ? 'released' : 'accepted' }
  }

  const deps: LoopDeps = {
    supplier: { id: SUPPLIER, name: "Avow's demo GPU supplier (test business)" },
    reserve: 10,
    agent: {
      suppliers: (o.suppliers ?? [SUPPLIER]).map((id) => ({ id, url: 'https://supplier.test' })),
      mandate: mandate as never,
      mandateHash: MANDATE_HASH,
      check: async () => o.check ?? passes,
      left: async () => o.left ?? 490,
      dailyLeft: async () => (o.dailyLeft === undefined ? null : o.dailyLeft),
      book,
    } as LoopDeps['agent'],
    cancel: async (id) => {
      cancelAttempts++
      if (o.cancel) return o.cancel(id, cancelAttempts)
      return { cancelledAt: now }
    },
    askForLateCharge: async (id, m): Promise<LateChargeReport> => {
      asked.push({ id, mandate: m })
      reportedAt = now
      return {
        commitmentId: id,
        amount: 5_000_000n,
        transaction: `0x${'ee'.repeat(32)}`,
        outcome: 'awaiting_avow',
      }
    },
    backing,
    clockMargin: 30n,
    now: () => now,
    sleep: async (ms) => {
      now += BigInt(Math.max(1, Math.round(ms / 1000)))
    },
    onStep: (s) => steps.push(s),
  }
  return {
    deps,
    steps,
    asked,
    booked: () => booked,
    cancelAttempts: () => cancelAttempts,
    reportedAt: () => reportedAt ?? -1n,
    now: () => now,
  }
}

describe('runLoop', () => {
  it('keeps one booking, cancels the other late, and follows both on the lock', async () => {
    const w = world()
    const outcome = await runLoop(w.deps)
    expect(w.booked()).toBe(2)
    expect(outcome.kept.state).toBe('released')
    expect(outcome.kept.reference.commitmentId).toBe(idOf(2))
    expect(outcome.cancelled.reference.commitmentId).toBe(idOf(1))
    // Avow is asked to record the cancellation the clock margin inside the late window, and the
    // supplier is asked to report the margin after it, so Avow confirms rather than refers.
    expect(outcome.cancelled.cancelledAt).toBeGreaterThanOrEqual(START + 120n + 30n)
    expect(outcome.cancelled.cancelledAt).toBeLessThanOrEqual(START + 360n - 30n)
    expect(w.reportedAt()).toBeGreaterThanOrEqual(outcome.cancelled.cancelledAt + 30n)
    expect(outcome.cancelled.charge).toMatchObject({ outcome: 'confirmed', amount: 5_000_000n })
    expect(outcome.cancelled.charge.paysAt).not.toBeNull()
    // The supplier is asked about the cancelled booking, with the mandate it was made under.
    expect(w.asked.map((a) => a.id)).toEqual([idOf(1)])
    expect(w.asked[0]?.mandate.actions).toContain('cancel')
    expect(w.steps.map((s) => s.type)).toEqual([
      'booking',
      'booked',
      'booking',
      'booked',
      'accepted',
      'accepted',
      'waiting',
      'cancelled',
      'reported',
      'waiting',
    ])
  })

  it.each([
    [
      'a mandate that names another supplier',
      { suppliers: ['someone-else'] },
      'mandate.supplier_not_allowed',
    ],
    [
      'a mandate that does not permit cancelling',
      { actions: ['reserve'] as Mandate['actions'] },
      'mandate.action_not_permitted',
    ],
    [
      'a booking the check refuses',
      {
        check: {
          ...passes,
          passes: false,
          code: 'mandate.over_commitment_cap',
          layer: 'sdk',
        } as SandboxPreflight,
      },
      'mandate.over_commitment_cap',
    ],
    ['too little authority left for two reserves', { left: 15 }, 'mandate.over_open_reserves_cap'],
    ['too little left on the key today', { dailyLeft: 19.99 }, 'keychain.over_daily_limit'],
  ] as const)('stops before booking anything on %s', async (_, o, reason) => {
    const w = world(o)
    const error = await runLoop(w.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LoopStopped)
    expect((error as LoopStopped).reason).toBe(reason)
    expect(w.booked()).toBe(0)
  })

  it("asks Avow again while Avow's clock says free cancellation is still open", async () => {
    const w = world({
      cancel: async (_, attempt) => {
        if (attempt < 3) {
          throw new AvowApiError('Cancel on the lock', {
            status: 409,
            reason: 'commitment.cancel_on_lock',
            requestId: `0x${'00'.repeat(32)}`,
            definite: true,
          })
        }
        return { cancelledAt: START + 200n }
      },
    })
    const outcome = await runLoop(w.deps)
    expect(w.cancelAttempts()).toBe(3)
    expect(outcome.cancelled.cancelledAt).toBe(START + 200n)
  })

  it('stops with Avow’s reason when Avow refuses the cancellation outright', async () => {
    const w = world({
      cancel: async () => {
        throw new AvowApiError('Closed', {
          status: 409,
          reason: 'commitment.cancel_closed',
          requestId: `0x${'00'.repeat(32)}`,
          definite: true,
        })
      },
    })
    const error = await runLoop(w.deps).catch((e: unknown) => e)
    expect((error as LoopStopped).reason).toBe('commitment.cancel_closed')
    expect(w.asked).toEqual([])
  })

  it('stops without cancelling when the late window is too near its close to confirm', async () => {
    const w = world({ acceptDelay: 170n })
    const error = await runLoop(w.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LoopStopped)
    expect(w.cancelAttempts()).toBe(0)
  })

  it('says where each booking stands when Avow or the release takes longer than the run waits', async () => {
    const w = world({ confirms: false, releases: false })
    const outcome = await runLoop(w.deps)
    expect(outcome.cancelled.charge).toMatchObject({ outcome: 'awaiting_avow', paysAt: null })
    expect(outcome.kept.state).toBe('accepted')
  })
})
