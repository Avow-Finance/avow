import { cancelSandboxCommitment, Refusal, sandbox } from '@avow-finance/sdk'
import { describe, expect, it } from 'vitest'

/**
 * How the two limits meet on Moderato. The authority caps what the agent holds at once, and the
 * key's daily limit caps what it moves in a day, cancelled reserves included. Runs when
 * AVOW_LIVE_TEMPO=1, from keys made for the run, once Avow's sandbox can pay a new business.
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

describe.skipIf(!live)('the two limits on Moderato', () => {
  it(
    'refuses a third $400 at the keychain, though the agent holds nothing',
    async () => {
      const store = sandbox.memoryStore()
      await sandbox.business({
        config: {
          name: 'Limits Live Test',
          authority: 500,
          dailyLimit: 1000,
          suppliers: [supplier],
        },
        prompts,
        store,
        session: null,
        log: () => {},
      })
      const agent = await sandbox.agent({ store, session: null, log: () => {} })
      expect(agent.dailyLimit).toBe(1000)
      // Twice, the agent books $400 and the business cancels it inside free cancellation.
      for (let i = 0; i < 2; i++) {
        const c = await agent.book(booking(400))
        await cancelSandboxCommitment({ commitmentId: c.commitment.commitmentId, prompts, store })
      }
      expect(await agent.left()).toBe(500)
      expect(await agent.dailyLeft()).toBe(200)
      const refused = await agent.book(booking(400)).then(
        () => null,
        (error: unknown) => error,
      )
      expect(refused).toBeInstanceOf(Refusal)
      expect(refused).toMatchObject({
        code: 'keychain.over_daily_limit',
        layer: 'keychain',
        amounts: {
          needed: 400_000_000n,
          left: 500_000_000n,
          dailyLimit: 1_000_000_000n,
          dailyLeft: 200_000_000n,
        },
      })
    },
    15 * 60_000,
  )
})
