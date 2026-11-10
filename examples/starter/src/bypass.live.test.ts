import { sandbox } from '@avow-finance/sdk'
import { describe, expect, it } from 'vitest'
import { tryToBypass } from '../template/bypass.js'

/**
 * The template's bypass script on Moderato, against a business and an agent made for the run. It
 * reads the agent's item exactly as the SDK stored it, so this is also what holds the script to
 * that item's shape. Runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const PASSPHRASE = 'a passphrase made for this run'
const prompts = {
  newPassphrase: async () => PASSPHRASE,
  passphrase: async () => PASSPHRASE,
  confirm: async () => true,
}

describe.skipIf(!live)('npm run bypass on Moderato', () => {
  it("lands the call the key allows and has the chain revert the three it doesn't, moving nothing", async () => {
    const store = sandbox.memoryStore()
    await sandbox.business({
      config: {
        name: 'Bypass Live Test',
        authority: 500,
        dailyLimit: 1000,
        suppliers: [{ id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }],
      },
      prompts,
      store,
      session: null,
      log: () => {},
    })
    const lines: string[] = []
    const { attempts, before, after } = await tryToBypass(await store.read('agent'), (l) =>
      lines.push(l),
    )
    expect(attempts.map((a) => [a.allowed, a.outcome, a.reason])).toEqual([
      [true, 'landed', null],
      [false, 'reverted', 'CallNotAllowed'],
      [false, 'reverted', 'CallNotAllowed'],
      [false, 'reverted', 'SpendingLimitExceeded'],
    ])
    // Each one reached a block, so each has a page in the explorer.
    for (const a of attempts) expect(a.link).toMatch(/\/tx\/0x[0-9a-f]{64}$/)
    expect(after).toBe(before)
    expect(lines.join('\n')).toContain("Tempo's keychain holds your agent's key to its mandate")
  }, 300_000)
})
