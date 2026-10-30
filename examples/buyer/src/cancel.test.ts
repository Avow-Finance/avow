import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AvowApiError, type Call, type Commitment, cancelFreeCall } from '@avow-finance/sdk'
import { describeReason, type ReasonCode } from '@avow-finance/spec'
import { formatTime, type LockedBacking } from '@avow-finance/verifier'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CancelDeps, cancelArgs, cancelBooking } from './cancel.js'
import { BuyerStore } from './store.js'
import { fundedBooking, heldFor, id, LOCK, NOW } from './test/bookings.js'

// Every key is generated for the run, and every state directory is removed after its test.
const TX: Hex = id('the cancellation on the lock')
const CANCELLED_AT = NOW + 400n

let dir: string
let store: BuyerStore
let booking: Commitment
let logged: string[]
let asked: Hex[]
let sent: Call[]
/** What Avow answers the agent's cancellation with, an answer or a refusal it throws. */
let avowSays: { ok: true; cancelledAt: bigint } | { ok: false; reason: ReasonCode } | AvowApiError
/** What the lock holds for the booking, and the chain's time. */
let held: LockedBacking | null
let chainNow: bigint

const refusal = (reason: ReasonCode) =>
  new AvowApiError(describeReason(reason), {
    status: reason === 'commitment.ended' ? 409 : 403,
    reason,
    requestId: id('the request'),
    definite: true,
  })

function deps(): CancelDeps {
  return {
    store,
    agent: {
      lock: LOCK,
      async cancel(commitmentId) {
        asked.push(commitmentId)
        if (avowSays instanceof AvowApiError) throw avowSays
        return avowSays
      },
      async commitment() {
        return held
      },
    },
    chainTime: async () => chainNow,
    sendFromRoot: async (call) => {
      sent.push(call)
      return { transactionHash: TX }
    },
    log: (line) => logged.push(line),
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'avow-buyer-cancel-'))
  store = new BuyerStore(dir)
  store.saveSetup({ lock: LOCK })
  booking = await fundedBooking()
  store.saveBooking(booking)
  logged = []
  asked = []
  sent = []
  avowSays = { ok: true, cancelledAt: CANCELLED_AT }
  held = heldFor(booking)
  chainNow = booking.terms.remedies.freeCancelBy - 60n
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('cancelling once free cancellation has ended', () => {
  it("has Avow record the late cancellation, and saves and logs Avow's time", async () => {
    expect(await cancelBooking(deps(), null)).toEqual({ by: 'avow', cancelledAt: CANCELLED_AT })
    expect(asked).toEqual([booking.commitmentId])
    expect(store.cancellation(booking.commitmentId)).toEqual({
      by: 'avow',
      cancelledAt: CANCELLED_AT,
    })
    expect(logged.at(-1)).toBe(
      `Avow recorded the cancellation of ${booking.commitmentId} at ${formatTime(CANCELLED_AT)}`,
    )
    expect(sent).toEqual([])
  })

  it('says plainly when the charge deadline has passed, and records nothing', async () => {
    avowSays = refusal('commitment.ended')
    await expect(cancelBooking(deps(), booking.commitmentId)).rejects.toThrow(
      `${booking.commitmentId} can no longer be cancelled, since its charge deadline has passed`,
    )
    expect(store.cancellation(booking.commitmentId)).toBeNull()
    expect(sent).toEqual([])
  })
})

describe('cancelling before free cancellation ends', () => {
  it('cancels on the lock with the root key when Avow says to, and gets the whole reserve back', async () => {
    avowSays = refusal('commitment.cancel_on_lock')
    expect(await cancelBooking(deps(), null)).toEqual({ by: 'lock', transactionHash: TX })
    expect(sent).toEqual([cancelFreeCall(LOCK, booking.commitmentId)])
    expect(store.cancellation(booking.commitmentId)).toEqual({ by: 'lock', transactionHash: TX })
    expect(logged.at(-1)).toContain(`on the lock in ${TX}, and the whole reserve went back`)
  })

  it('cancels a reserve the supplier has not accepted yet the same way', async () => {
    avowSays = refusal('commitment.cancel_on_lock')
    held = heldFor(booking, { state: 'reserved' })
    expect((await cancelBooking(deps(), null)).by).toBe('lock')
    expect(sent).toHaveLength(1)
  })

  it('sends the lock nothing it would refuse, and records nothing', async () => {
    avowSays = refusal('commitment.cancel_on_lock')
    const freeCancelBy = booking.terms.remedies.freeCancelBy
    const cases: [() => void, string][] = [
      [() => (chainNow = freeCancelBy), 'Run cancel again to have Avow record a late cancellation'],
      [() => (held = heldFor(booking, { hasReport: true })), 'with a report open'],
      [
        () => (held = heldFor(booking, { state: 'charge_pending', hasReport: true })),
        'as charge_pending',
      ],
      [() => (held = heldFor(booking, { state: 'released' })), 'already given the reserve'],
      [() => (held = null), 'holds no reserve'],
    ]
    for (const [arrange, says] of cases) {
      chainNow = freeCancelBy - 60n
      held = heldFor(booking)
      arrange()
      await expect(cancelBooking(deps(), null), says).rejects.toThrow(says)
    }
    expect(sent).toEqual([])
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })
})

describe('a booking the store already shows cancelled', () => {
  it('says so without asking Avow again, however it was cancelled', async () => {
    await cancelBooking(deps(), null)
    expect(await cancelBooking(deps(), booking.commitmentId)).toEqual({
      by: 'avow',
      cancelledAt: CANCELLED_AT,
    })
    expect(asked).toHaveLength(1)
    expect(logged.at(-1)).toBe(
      `${booking.commitmentId} is already cancelled, Avow recorded it at ${formatTime(CANCELLED_AT)}, so Avow isn't asked again`,
    )

    const other = await fundedBooking(NOW + 60n)
    store.saveBooking(other)
    avowSays = refusal('commitment.cancel_on_lock')
    held = heldFor(other)
    await cancelBooking(deps(), other.commitmentId)
    await cancelBooking(deps(), other.commitmentId)
    expect(asked).toEqual([booking.commitmentId, other.commitmentId])
    expect(sent).toHaveLength(1)
    expect(logged.at(-1)).toContain(`on the lock in ${TX}`)
  })
})

describe('which booking it cancels', () => {
  it('cancels the booking named, or the one the agent made last', async () => {
    const later = await fundedBooking(NOW + 3600n)
    store.saveBooking(later)
    await cancelBooking(deps(), null)
    expect(asked).toEqual([later.commitmentId])
    await cancelBooking(deps(), booking.commitmentId)
    expect(asked).toEqual([later.commitmentId, booking.commitmentId])
  })

  it("refuses a booking that was never funded, and one the store doesn't hold", async () => {
    // Made after the funded booking, so it's the one made last.
    const { reservedIn: _, ...approved } = await fundedBooking(NOW + 60n)
    store.saveBooking({ ...approved, outcome: 'failed' })
    await expect(cancelBooking(deps(), null)).rejects.toThrow('was never funded')
    await expect(cancelBooking(deps(), id('another commitment'))).rejects.toThrow(
      `holds no booking for ${id('another commitment')}`,
    )
    expect(asked).toEqual([])
  })

  it('says when the store holds no booking at all', async () => {
    const empty = new BuyerStore(join(dir, 'empty'))
    empty.saveSetup({ lock: LOCK })
    await expect(cancelBooking({ ...deps(), store: empty }, null)).rejects.toThrow(
      'holds no booking yet. Run book first.',
    )
  })
})

describe("Avow's other answers", () => {
  it('says how to get a mandate that permits cancelling', async () => {
    avowSays = { ok: false, reason: 'mandate.action_not_permitted' }
    await expect(cancelBooking(deps(), null)).rejects.toThrow(
      "The mandate doesn't permit this action (mandate.action_not_permitted). A business enrolled before cancel existed enrolls again with a new STATE_DIR.",
    )
  })

  it('says Avow may have recorded a cancellation it gave no definite answer to', async () => {
    avowSays = new AvowApiError('No definite answer from Avow.', {
      status: 0,
      reason: null,
      requestId: id('the request'),
      definite: false,
    })
    await expect(cancelBooking(deps(), null)).rejects.toThrow(
      `Avow gave no definite answer, so it may have recorded the cancellation of ${booking.commitmentId}.`,
    )
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })

  it('passes on any other refusal as Avow gave it', async () => {
    avowSays = refusal('agent.revoked')
    await expect(cancelBooking(deps(), null)).rejects.toBe(avowSays)
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })
})

describe("the command's arguments", () => {
  it('takes one commitment id at most, as 32 bytes of hex', () => {
    expect(cancelArgs([])).toEqual({ commitmentId: null })
    const upper = `0x${'AB'.repeat(32)}`
    expect(cancelArgs([upper])).toEqual({ commitmentId: upper.toLowerCase() })
    expect(() => cancelArgs(['0x1234'])).toThrow("isn't a commitment id")
    expect(() => cancelArgs([upper, upper])).toThrow('one commitment id at most')
  })
})
