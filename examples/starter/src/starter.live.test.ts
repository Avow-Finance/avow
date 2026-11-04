import { moderatoClient, Refusal, sandbox } from '@avow-finance/sdk'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'

/**
 * The starter's loop on Moderato, as the runner and agent.ts run it, from keys made for the run
 * and held only in memory. The business's side signs the mandate and the agent's side books with
 * only the agent's key. Avow's sandbox registers the business and pays its test dollars, so it
 * needs no secrets. Runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const supplier = { id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }
const PASSPHRASE = 'a passphrase made for this run'
const prompts = {
  newPassphrase: async () => PASSPHRASE,
  passphrase: async () => PASSPHRASE,
  confirm: async () => true,
}
const booking = (reserve: number) => ({
  supplier: supplier.id,
  resource: { gpu: 'H100', count: 8, hours: 1 },
  reserve,
})

describe.skipIf(!live)('the starter on Moderato', () => {
  it(
    'commits $200, refuses $400 with $300 left, commits $250, then revokes the key for a new authority',
    async () => {
      const store = sandbox.memoryStore()
      const lines: string[] = []
      const log = (l: string) => lines.push(l)
      const business = (authority: number) =>
        sandbox.business({
          config: { name: 'Starter Live Test', authority, suppliers: [supplier] },
          prompts,
          store,
          session: null,
          log,
        })
      expect((await business(500)).signed).toBe(true)
      const agent = await sandbox.agent({ store, session: null, log })
      expect(await agent.left()).toBe(500)

      const first = await agent.book(booking(200))
      expect(first.left).toBe(300)
      expect(first.link).toMatch(/^https:\/\/try\.testnet\.avow\.finance\/#verify=[A-Za-z0-9_-]+$/)
      const checks = await first.verify()
      expect(checks.length).toBe(5)
      expect(checks.filter((c) => !c.passed)).toEqual([])
      expect(await first.accepted()).toBe(true)

      const refused = await agent.book(booking(400)).then(
        () => null,
        (error: unknown) => error,
      )
      expect(refused).toBeInstanceOf(Refusal)
      expect(refused).toMatchObject({
        code: 'mandate.over_open_reserves_cap',
        layer: 'avow',
        amounts: { needed: 400_000_000n, left: 300_000_000n, authority: 500_000_000n },
      })
      expect((refused as Refusal).message).toMatch(
        /^This booking needs \$400 and your agent has \$300 of authority left, so Avow refused the reserve and no money moved\./,
      )

      const second = await agent.book(booking(250))
      expect(second.left).toBe(50)
      expect((await agent.commitments()).map((c) => c.amount)).toEqual([200, 250])

      // A lower authority is a new mandate for a new key, and the old key is revoked on chain.
      expect((await business(100)).signed).toBe(true)
      const lowered = await sandbox.agent({ store, session: null, log })
      expect(lowered.mandateHash).not.toBe(agent.mandateHash)
      expect(await lowered.left()).toBe(100)
      const [old] = await moderatoClient()
        .readContract({
          address: Addresses.accountKeychain,
          abi: Abis.accountKeychain,
          functionName: 'getKey',
          args: [agent.business.account, agent.mandate.message.agentKey],
        })
        .then((k) => [k.isRevoked])
      expect(old).toBe(true)
      expect(lines.some((l) => l.includes('stay held in the lock until their release'))).toBe(true)
      expect((await lowered.commitments()).every((c) => !c.current)).toBe(true)
    },
    15 * 60_000,
  )
})
