import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ADMINISTRATOR_ABI,
  AvowApiError,
  type Call,
  type Commitment,
  cancelFreeCall,
  SendError,
} from '@avow-finance/sdk'
import { describeReason, type ReasonCode } from '@avow-finance/spec'
import { formatTime, type LockedBacking } from '@avow-finance/verifier'
import { decodeFunctionData, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CancelDeps, cancelArgs, cancelBooking } from './cancel.js'
import { BuyerStore } from './store.js'
import { fundedBooking, heldFor, id, LOCK, NOW } from './test/bookings.js'

// Every key is generated for the run, and every state directory is removed after its test.
const TX: Hex = id('the cancellation on the lock')
const EARLIER_TX: Hex = id('a cancellation an earlier run sent')

let dir: string
let store: BuyerStore
let booking: Commitment
/** Free cancellation of the booking is open on the chain before this time, and ended from it. */
let freeCancelBy: bigint
let logged: string[]
let asked: Hex[]
let sent: Call[]
/** What Avow answers the agent's cancellation with, an answer or a refusal it throws. */
let avowSays: { ok: true; cancelledAt: bigint } | { ok: false; reason: ReasonCode } | AvowApiError
/** What the lock holds for the booking, the chain's times and the receipts it holds. */
let held: LockedBacking | null
let chainNow: bigint
let finalizedNow: bigint
let receipts: Map<Hex, 'success' | 'reverted'>
/** What happens to a cancellation sent to the lock. */
let sendDoes: 'land' | 'fail' | 'land unseen'

/** A refusal Avow answers with this status, as the SDK throws it. */
const refusal = (reason: ReasonCode, status = 409, message = describeReason(reason)) =>
  new AvowApiError(message, { status, reason, requestId: id('the request'), definite: true })

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
    finalizedTime: async () => finalizedNow,
    sendFromRoot: async (call, onSent) => {
      sent.push(call)
      const [commitmentId] = decodeFunctionData({ abi: ADMINISTRATOR_ABI, data: call.data })
        .args as [Hex, number]
      await onSent(TX, chainNow + 25n)
      // The store names the transaction before its bytes go anywhere.
      expect(store.cancellation(commitmentId)).toEqual({
        by: 'lock',
        sent: { hash: TX, validBefore: chainNow + 25n },
      })
      if (sendDoes === 'fail') {
        throw new SendError(`The transaction ${TX} reverted`, 'failed', {
          hashes: [TX],
          signings: 1,
        })
      }
      // The lock gives the whole reserve back.
      if (held) held = { ...held, state: 'released', held: 0n }
      receipts.set(TX, 'success')
      if (sendDoes === 'land unseen') {
        throw new SendError(`No receipt for ${TX} after waiting`, 'unknown', {
          hashes: [TX],
          signings: 1,
        })
      }
      return { transactionHash: TX }
    },
    receipt: async (hash) => receipts.get(hash) ?? null,
    log: (line) => logged.push(line),
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'avow-buyer-cancel-'))
  store = new BuyerStore(dir)
  store.saveSetup({ lock: LOCK })
  booking = await fundedBooking()
  store.saveBooking(booking)
  freeCancelBy = booking.terms.remedies.freeCancelBy
  logged = []
  asked = []
  sent = []
  avowSays = { ok: true, cancelledAt: freeCancelBy + 40n }
  held = heldFor(booking)
  // A minute after free cancellation ended, by the chain's clock.
  chainNow = freeCancelBy + 60n
  finalizedNow = chainNow
  receipts = new Map()
  sendDoes = 'land'
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A minute before free cancellation ends, by the chain's clock. */
const whileFree = () => {
  chainNow = freeCancelBy - 60n
  finalizedNow = chainNow
}

describe('cancelling once free cancellation has ended on the chain', () => {
  it("has Avow record the late cancellation, and saves and logs Avow's time", async () => {
    expect(await cancelBooking(deps(), null)).toEqual({
      by: 'avow',
      cancelledAt: freeCancelBy + 40n,
    })
    expect(asked).toEqual([booking.commitmentId])
    expect(store.cancellation(booking.commitmentId)).toEqual({
      by: 'avow',
      cancelledAt: freeCancelBy + 40n,
    })
    expect(logged.at(-1)).toBe(
      `Avow recorded the cancellation of ${booking.commitmentId} at ${formatTime(freeCancelBy + 40n)}`,
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

  it('says cancelling no longer changes the charge once the no-show charge can be reported', async () => {
    avowSays = refusal('commitment.cancel_closed')
    await expect(cancelBooking(deps(), booking.commitmentId)).rejects.toThrow(
      `The supplier can already report the no-show charge for ${booking.commitmentId}, so cancelling now wouldn't change what the business pays, and Avow recorded nothing`,
    )
    expect(asked).toEqual([booking.commitmentId])
    expect(store.cancellation(booking.commitmentId)).toBeNull()
    expect(sent).toEqual([])
  })

  it('never asks Avow to cancel a commitment the lock has already ended', async () => {
    const cases: [LockedBacking | null, string][] = [
      [heldFor(booking, { state: 'released' }), 'already given the reserve back to the business'],
      [heldFor(booking, { state: 'charged', hasReport: true }), 'already paid the charge'],
      [heldFor(booking, { state: 'resolved', hasReport: true }), 'settled the charge'],
      [null, 'holds no reserve'],
    ]
    for (const [lock, says] of cases) {
      held = lock
      await expect(cancelBooking(deps(), null), says).rejects.toThrow(says)
    }
    expect(asked).toEqual([])
    expect(sent).toEqual([])
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })

  it("explains Avow's clock still showing free cancellation when the chain's doesn't", async () => {
    avowSays = refusal('commitment.cancel_on_lock')
    await expect(cancelBooking(deps(), null)).rejects.toThrow(
      `Avow says free cancellation of ${booking.commitmentId} hasn't ended, and the lock won't take a free cancellation now`,
    )
    expect(sent).toEqual([])
  })
})

describe('cancelling while free cancellation is open on the chain', () => {
  it('cancels on the lock with the root key, without asking Avow, and gets the whole reserve back', async () => {
    whileFree()
    expect(await cancelBooking(deps(), null)).toEqual({ by: 'lock', transactionHash: TX })
    expect(sent).toEqual([cancelFreeCall(LOCK, booking.commitmentId)])
    expect(asked).toEqual([])
    expect(store.cancellation(booking.commitmentId)).toEqual({ by: 'lock', transactionHash: TX })
    expect(logged.at(-1)).toContain(`on the lock in ${TX}, and the whole reserve went back`)
  })

  it("cancels a reserve the supplier hasn't accepted yet the same way", async () => {
    whileFree()
    held = heldFor(booking, { state: 'reserved' })
    expect((await cancelBooking(deps(), null)).by).toBe('lock')
    expect(sent).toHaveLength(1)
  })

  it("takes the lock path whatever the agent's mandate permits", async () => {
    whileFree()
    // A mandate made before cancel existed, which Avow and the SDK refuse to cancel under.
    avowSays = { ok: false, reason: 'mandate.action_not_permitted' }
    expect(await cancelBooking(deps(), null)).toEqual({ by: 'lock', transactionHash: TX })
    expect(asked).toEqual([])
  })

  it('says a send that failed left the reserve on the lock, forgets it and cancels on a rerun', async () => {
    whileFree()
    sendDoes = 'fail'
    await expect(cancelBooking(deps(), null)).rejects.toThrow(
      `The free cancellation of ${booking.commitmentId} failed, so the lock still holds the reserve`,
    )
    expect(store.cancellation(booking.commitmentId)).toBeNull()
    sendDoes = 'land'
    expect((await cancelBooking(deps(), null)).by).toBe('lock')
    expect(sent).toHaveLength(2)
    expect(asked).toEqual([])
  })
})

describe('a cancellation sent to the lock that the run never saw land', () => {
  for (const [when, rerunAt] of [
    ['before free cancellation ends', () => whileFree()],
    [
      'after free cancellation ended',
      () => {
        chainNow = freeCancelBy + 60n
        finalizedNow = chainNow
      },
    ],
  ] as const) {
    it(`settles from its receipt on a rerun ${when}, and never asks Avow`, async () => {
      whileFree()
      sendDoes = 'land unseen'
      await expect(cancelBooking(deps(), null)).rejects.toThrow(
        `Whether the free cancellation of ${booking.commitmentId} landed is unknown`,
      )
      expect(store.cancellation(booking.commitmentId)).toMatchObject({ sent: { hash: TX } })
      expect(held?.state).toBe('released')
      rerunAt()
      expect(await cancelBooking(deps(), null)).toEqual({ by: 'lock', transactionHash: TX })
      expect(store.cancellation(booking.commitmentId)).toEqual({ by: 'lock', transactionHash: TX })
      expect(logged.at(-1)).toContain(`sent in ${TX} landed`)
      expect(asked).toEqual([])
      expect(sent).toHaveLength(1)
    })
  }

  const sentEarlier = (validBefore: bigint | null) =>
    store.saveCancellation(booking.commitmentId, {
      by: 'lock',
      sent: { hash: EARLIER_TX, validBefore },
    })

  it('stops while it may still land, and sends nothing', async () => {
    whileFree()
    sentEarlier(finalizedNow)
    await expect(cancelBooking(deps(), null)).rejects.toThrow(
      `The cancellation of ${booking.commitmentId} sent in ${EARLIER_TX} may still land`,
    )
    sentEarlier(null)
    await expect(cancelBooking(deps(), null)).rejects.toThrow('may still land')
    expect(sent).toEqual([])
    expect(asked).toEqual([])
  })

  it('settles one that lands while the run reads the chain, and never forgets it', async () => {
    whileFree()
    sentEarlier(finalizedNow)
    const reading = deps()
    reading.finalizedTime = async () => {
      // It lands in its last valid block, which finalizes as the run reads the chain.
      receipts.set(EARLIER_TX, 'success')
      if (held) held = { ...held, state: 'released', held: 0n }
      return finalizedNow + 1n
    }
    expect(await cancelBooking(reading, null)).toEqual({ by: 'lock', transactionHash: EARLIER_TX })
    expect(sent).toEqual([])
    expect(asked).toEqual([])
  })

  it('forgets one that never landed, and goes on from what the lock holds', async () => {
    whileFree()
    sentEarlier(finalizedNow - 1n)
    expect(await cancelBooking(deps(), null)).toEqual({ by: 'lock', transactionHash: TX })
    expect(logged).toContain(
      `the cancellation of ${booking.commitmentId} sent in ${EARLIER_TX} never landed`,
    )
    // One whose receipt shows it reverted never landed either.
    const other = await fundedBooking(NOW + 60n)
    store.saveBooking(other)
    store.saveCancellation(other.commitmentId, {
      by: 'lock',
      sent: { hash: EARLIER_TX, validBefore: null },
    })
    receipts.set(EARLIER_TX, 'reverted')
    held = heldFor(other)
    expect((await cancelBooking(deps(), other.commitmentId)).by).toBe('lock')
    expect(asked).toEqual([])
  })

  it('never has Avow record a late cancellation of a reserve the lock gave back another way', async () => {
    sentEarlier(finalizedNow - 1n)
    held = heldFor(booking, { state: 'released' })
    await expect(cancelBooking(deps(), null)).rejects.toThrow(
      'The lock has already given the reserve back to the business',
    )
    expect(asked).toEqual([])
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })
})

describe('a booking the store already shows cancelled', () => {
  it('says so without asking Avow again, however it was cancelled', async () => {
    await cancelBooking(deps(), null)
    expect(await cancelBooking(deps(), booking.commitmentId)).toEqual({
      by: 'avow',
      cancelledAt: freeCancelBy + 40n,
    })
    expect(asked).toHaveLength(1)
    expect(logged.at(-1)).toBe(
      `${booking.commitmentId} is already cancelled, Avow recorded it at ${formatTime(freeCancelBy + 40n)}, so Avow isn't asked again`,
    )

    const other = await fundedBooking(NOW + 600n)
    store.saveBooking(other)
    held = heldFor(other)
    whileFree()
    await cancelBooking(deps(), other.commitmentId)
    await cancelBooking(deps(), other.commitmentId)
    expect(asked).toEqual([booking.commitmentId])
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
  it('says where a mandate that permits cancelling comes from, once the lock path has closed', async () => {
    const cases: [string, typeof avowSays][] = [
      ['the SDK, from the mandate it holds', { ok: false, reason: 'mandate.action_not_permitted' }],
      ['Avow, from the mandate it holds', refusal('mandate.action_not_permitted', 403)],
    ]
    for (const [from, says] of cases) {
      avowSays = says
      await expect(cancelBooking(deps(), null), from).rejects.toThrow(
        'Enrolling again keeps this mandate. A mandate that permits cancel and start comes from running init with a new STATE_DIR, having Avow register the new account and lock, and then running enroll.',
      )
    }
    expect(sent).toEqual([])
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })

  it("says Avow may hold a cancellation whose record doesn't check out, and saves nothing", async () => {
    // What the SDK throws when Avow's timestamp names neither this request nor the earlier one
    // the answer says carried the cancellation.
    avowSays = new AvowApiError(
      `Avow's answer can't be used: ${describeReason('message.invalid')}`,
      {
        status: 200,
        reason: 'message.invalid',
        requestId: id('the request'),
        definite: true,
      },
    )
    await expect(cancelBooking(deps(), null)).rejects.toThrow(
      `Avow answered the cancellation of ${booking.commitmentId}, but its record doesn't check out against the request this run signed, so nothing was saved. Avow may hold the cancellation. Run cancel again, which asks Avow for its record.`,
    )
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })

  it('passes on a message.invalid refusal as Avow gave it, since Avow recorded nothing', async () => {
    // What Avow answers when a value in the body can't be stored.
    avowSays = refusal('message.invalid', 400, "A value in the body can't be stored")
    await expect(cancelBooking(deps(), null)).rejects.toBe(avowSays)
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })

  it('says Avow may have recorded a cancellation it gave no definite answer to', async () => {
    avowSays = new AvowApiError('No definite answer from Avow.', {
      status: 0,
      reason: null,
      requestId: id('the request'),
      definite: false,
    })
    await expect(cancelBooking(deps(), null)).rejects.toThrow(
      `Avow gave no definite answer, so it may have recorded the cancellation of ${booking.commitmentId}. Run cancel again, and if Avow recorded it, it answers with the time it recorded.`,
    )
    expect(store.cancellation(booking.commitmentId)).toBeNull()
  })

  it('passes on any other refusal as Avow gave it', async () => {
    avowSays = refusal('agent.revoked', 403)
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
