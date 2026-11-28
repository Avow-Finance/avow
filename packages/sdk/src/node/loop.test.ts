import type { CommitmentReference } from '@avow-finance/spec'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { LoopOutcome } from '../sandbox/loop.js'
import { introLines, outcomeLines, readLoopArgs, stepLine } from './loop.js'

const ref = (n: number) =>
  ({ commitmentId: `0x${n.toString(16).padStart(64, '0')}` as Hex }) as CommitmentReference
const outcome = (
  charge: Partial<LoopOutcome['cancelled']['charge']>,
  kept = 'released',
): LoopOutcome =>
  ({
    kept: { link: 'https://try.testnet.avow.finance/#verify=kept', reference: ref(2), state: kept },
    cancelled: {
      link: 'https://try.testnet.avow.finance/#verify=late',
      reference: ref(1),
      cancelledAt: 1_800_000_130n,
      charge: {
        amount: 5_000_000n,
        transaction: `0x${'ee'.repeat(32)}`,
        outcome: 'confirmed',
        paysAt: 1_800_000_800n,
        ...charge,
      },
    },
  }) as LoopOutcome

describe('avow-sandbox loop', () => {
  it('takes a reserve in dollars and nothing else', () => {
    expect(readLoopArgs([])).toEqual({ reserve: 10 })
    expect(readLoopArgs(['--reserve', '12.50'])).toEqual({ reserve: 12.5 })
    expect(readLoopArgs(['--reserve', '0'])).toHaveProperty('error')
    expect(readLoopArgs(['--reserve', '1.234'])).toHaveProperty('error')
    expect(readLoopArgs(['--reserve'])).toHaveProperty('error')
    expect(readLoopArgs(['--approve'])).toHaveProperty('error')
  })

  it('says what the run spends and labels the supplier as a test business before booking', () => {
    const text = introLines(10).join('\n')
    expect(text).toContain('(test business)')
    expect(text).toContain('$5 of its test dollars')
    expect(text).toContain('within the limits your administrator signed')
  })

  it('gives the link to check each booking and the report on the explorer', () => {
    const booked = stepLine({
      type: 'booked',
      role: 'kept',
      link: 'https://try.testnet.avow.finance/#verify=kept',
      reference: ref(2),
      reserve: 10_000_000n,
      freeCancelBy: 1_800_000_120n,
      releaseDate: 1_800_000_300n,
    })
    expect(booked).toContain('$10')
    expect(booked).toContain('#verify=kept')
    const reported = stepLine({
      type: 'reported',
      amount: 5_000_000n,
      transaction: `0x${'ee'.repeat(32)}`,
    })
    expect(reported).toContain(`https://explore.testnet.tempo.xyz/tx/0x${'ee'.repeat(32)}`)
  })

  it('says what became of each booking, a charge paused for a ruling included', () => {
    const [kept, late] = outcomeLines(outcome({}))
    expect(kept).toContain('whole reserve back')
    expect(late).toContain('Avow confirmed the $5 late-cancellation charge')
    expect(late).toContain('2027-01-15T08:13:20.000Z')
    expect(outcomeLines(outcome({ outcome: 'ruling', paysAt: null }))[1]).toContain('ruling')
    expect(outcomeLines(outcome({}, 'accepted'))[0]).toContain("hasn't landed yet")
  })
})
