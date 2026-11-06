import { describe, expect, it } from 'vitest'
import { SendError } from '../send.js'
import { fixtureWorld } from './fixture-world.js'
import { cancelBooking } from './live-world.js'
import type { LockRead, WorldBooking } from './world.js'

/** A firm booking from the fixture world, and its lock read with free cancellation open or not. */
async function booking(): Promise<{ booking: WorldBooking; open: LockRead; closed: LockRead }> {
  const world = fixtureWorld()
  const order = await world.pullOrder()
  const firm = (await world.offers(order)).offers.find((o) => o.id === 'h100-firm')
  if (!firm) throw new Error('the demo lists a firm offer')
  const booked = await world.book(firm, 1)
  if (!booked.ok) throw new Error(booked.code)
  const read = booked.booking.read
  return {
    booking: { ...booked.booking, id: 'b1' },
    open: { ...read, freeCancelBy: read.block.timestamp + 600n },
    closed: { ...read, freeCancelBy: read.block.timestamp },
  }
}

const never = async () => {
  throw new Error('the developer should not be asked')
}

describe('cancelling a booking a model asked to cancel', () => {
  it('cancels nothing when the booking can’t be read, as the tool layer’s own refusal', async () => {
    const b = await booking()
    const unreadable = await cancelBooking(
      b.booking,
      async () => {
        throw new Error('HTTP request failed')
      },
      never,
    )
    expect(unreadable).toMatchObject({ ok: false, code: 'reference.unreadable', layer: 'service' })
    expect(await cancelBooking(b.booking, async () => null, never)).toMatchObject({
      code: 'reference.unreadable',
      layer: 'service',
    })
  })

  it('asks the developer only while free cancellation is open', async () => {
    const b = await booking()
    expect(await cancelBooking(b.booking, async () => b.closed, never)).toMatchObject({
      code: 'service.cancel_late',
      layer: 'service',
    })
    const asked: LockRead[] = []
    const declined = await cancelBooking(
      b.booking,
      async () => b.open,
      async (_, read) => {
        asked.push(read)
        return null
      },
    )
    expect(declined).toMatchObject({ code: 'service.cancel_declined', layer: 'service' })
    expect(asked).toEqual([b.open])
    const hash = `0x${'cc'.repeat(32)}` as const
    expect(
      await cancelBooking(
        b.booking,
        async () => b.open,
        async () => hash,
      ),
    ).toEqual({
      ok: true,
      transactionHash: hash,
    })
  })

  it('gives a cancellation the lock reverted as the lock’s refusal', async () => {
    const b = await booking()
    const reverted = new SendError(
      `The transaction 0x${'dd'.repeat(32)} reverted`,
      'failed',
      { hashes: [], signings: 1 },
      { stage: 'landed' },
    )
    const result = await cancelBooking(
      b.booking,
      async () => b.open,
      async () => {
        throw reverted
      },
    )
    expect(result).toMatchObject({ ok: false, code: 'chain.cancel_reverted', layer: 'lock' })
  })
})
