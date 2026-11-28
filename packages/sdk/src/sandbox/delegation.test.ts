import { dollars } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { bookingFixture, NOW } from '../test/fixture.js'
import { workerLimits } from './delegation.js'

describe("a worker's limits from what its agent asks", () => {
  it("keeps every limit the agent's own unless asked narrower", async () => {
    const { mandate } = await bookingFixture()
    expect(workerLimits(mandate, {}, NOW)).toMatchObject({
      capPerCommitment: mandate.capPerCommitment,
      capOpenReserves: mandate.capOpenReserves,
      suppliers: mandate.suppliers,
      expiry: mandate.expiry,
    })
  })

  it('takes dollars and days, and never ends past the mandate', async () => {
    const { mandate } = await bookingFixture()
    const asked = workerLimits(mandate, { perCommitment: 200, atOnce: 400, days: 0.5 }, NOW)
    expect(asked.capPerCommitment).toBe(dollars(200))
    expect(asked.capOpenReserves).toBe(dollars(400))
    expect(asked.expiry).toBe(NOW + 43_200n)
    expect(workerLimits(mandate, { days: 365 }, NOW).expiry).toBe(mandate.expiry)
  })
})
