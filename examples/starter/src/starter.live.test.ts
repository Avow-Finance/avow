import { Refusal, sandbox } from '@avow-finance/sdk'
import { describe, expect, it } from 'vitest'

/**
 * The starter's loop on Moderato, as agent.ts runs it, from keys made for the run and held only in
 * memory. Avow's sandbox registers the business and pays its test dollars, so it needs no secrets.
 * Runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const supplier = { id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }
const booking = (reserve: number) => ({
  supplier: supplier.id,
  resource: { gpu: 'H100', count: 8, hours: 1 },
  reserve,
})

describe.skipIf(!live)('the starter on Moderato', () => {
  it(
    'commits $200, refuses $400 with $300 left, commits $250, then takes a new authority',
    async () => {
      const store = sandbox.memoryStore()
      const lines: string[] = []
      const options = {
        suppliers: [supplier],
        store,
        session: null,
        log: (l: string) => lines.push(l),
      }
      const agent = await sandbox.agent({ ...options, authority: 500 })
      expect(await agent.left()).toBe(500)

      const first = await agent.book(booking(200))
      expect(first.amount).toBe(200)
      expect(first.left).toBe(300)
      expect(first.link).toMatch(/^https:\/\/try\.testnet\.avow\.finance\/#verify=[A-Za-z0-9_-]+$/)
      const checks = await first.verify()
      expect(checks.map((c) => [c.passed, c.reason])).toEqual([
        [true, null],
        [true, null],
      ])
      expect(await first.accepted()).toBe(true)

      const refused = await agent.book(booking(400)).then(
        () => null,
        (error: unknown) => error,
      )
      expect(refused).toBeInstanceOf(Refusal)
      expect(refused).toMatchObject({
        code: 'mandate.over_open_reserves_cap',
        layer: 'avow',
        amounts: {
          needed: 400_000_000n,
          left: 300_000_000n,
          authority: 500_000_000n,
          dailyLimit: 500_000_000n,
        },
      })
      expect((refused as Refusal).message).toBe(
        "This booking needs $400 and your agent has $300 of authority left, so Avow refused the reserve and no money moved. The lock takes no reserve without Avow's approval, and your agent's key can't move more than $500 a day, a limit your business set on chain.",
      )

      const second = await agent.book(booking(250))
      expect(second.left).toBe(50)
      expect(second.reference.commitmentId).not.toBe(first.reference.commitmentId)

      // A new authority in agent.ts is a new mandate, which the lock counts apart from the old one.
      const raised = await sandbox.agent({ ...options, authority: 800 })
      expect(raised.mandateHash).not.toBe(agent.mandateHash)
      expect(await raised.left()).toBe(800)
      expect(lines.some((l) => l.includes('changed from $500 with avow-demo-gpu to $800'))).toBe(
        true,
      )
    },
    15 * 60_000,
  )
})
