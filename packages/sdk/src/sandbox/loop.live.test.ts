import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileStore } from '../node/platform.js'
import { type LoopStep, sandboxLoop } from './loop.js'
import { prepareSandboxBusiness } from './setup.js'

/**
 * The whole loop on Moderato against Avow's demo GPU supplier, from a sandbox business set up for
 * the run with keys held in a folder made for it. The setup stands in for the administrator's
 * approval, and the loop runs with only the agent's key after it. Runs when AVOW_LIVE_TEMPO=1,
 * once Avow's sandbox can pay a new business.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const PASSPHRASE = 'a passphrase made for this run'

describe.skipIf(!live)('the loop on Moderato', () => {
  it(
    'keeps one $10 booking, which comes back whole, and Avow confirms a $5 late-cancellation charge on the other',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'avow-loop-live-'))
      const store = fileStore(join(dir, '.avow'))
      await prepareSandboxBusiness({
        config: {
          name: 'Loop Live Test',
          authority: 500,
          dailyLimit: 1000,
          suppliers: [{ id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }],
        },
        prompts: {
          newPassphrase: async () => PASSPHRASE,
          passphrase: async () => PASSPHRASE,
          confirm: async () => true,
        },
        store,
        session: null,
        log: () => {},
      })
      const steps: LoopStep[] = []
      const outcome = await sandboxLoop({
        store,
        reserve: 10,
        onStep: (s) => steps.push(s),
        log: () => {},
      })
      expect(steps.filter((s) => s.type === 'accepted')).toHaveLength(2)
      expect(outcome.cancelled.charge.amount).toBe(5_000_000n)
      expect(outcome.cancelled.charge.outcome).toBe('confirmed')
      expect(outcome.cancelled.charge.paysAt).not.toBeNull()
      expect(outcome.kept.state).toBe('released')
    },
    20 * 60_000,
  )
})
