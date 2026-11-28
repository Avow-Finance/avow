import type { CommitmentReference } from '@avow-finance/spec'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { type LoopOutcome, LoopStopped } from '../sandbox/loop.js'
import { introLines, outcomeLines, readLoopArgs, stepLine, stoppedLines } from './loop.js'

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
    expect(readLoopArgs(['--reserve', '19.99'])).toEqual({ reserve: 19.99 })
    expect(readLoopArgs(['--reserve', '0.29'])).toEqual({ reserve: 0.29 })
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

  it('prints the reason code and every reserve a stopped run left, with its release and link', () => {
    const stop = new LoopStopped(
      "Avow's demo GPU supplier (test business) didn't report the charge",
      'service.unavailable',
      {
        held: [
          {
            role: 'cancelled',
            link: 'https://try.testnet.avow.finance/#verify=late',
            reference: ref(1),
            reserve: 10_000_000n,
            releaseDate: 1_800_000_480n,
            chargeAsked: true,
            landed: 'yes',
          },
          {
            role: 'kept',
            link: 'https://try.testnet.avow.finance/#verify=kept',
            reference: ref(2),
            reserve: 10_000_000n,
            releaseDate: 1_800_000_500n,
            chargeAsked: false,
            landed: 'yes',
          },
        ],
      },
    )
    const [message, reason, late, kept] = stoppedLines(stop)
    expect(message).toContain("didn't report the charge")
    expect(reason).toBe('The reason code is service.unavailable.')
    expect(late).toContain('$10')
    expect(late).toContain('comes back whole by its release date, 2027-01-15T08:08:00.000Z')
    expect(late).toContain(
      'less the late-cancellation charge the run asked the supplier for if Avow confirms it',
    )
    expect(late).toContain('#verify=late')
    expect(kept).not.toContain('late-cancellation charge')
    expect(kept).toContain('#verify=kept')
    expect(stoppedLines(new LoopStopped('No supplier', null))).toEqual([
      'No supplier',
      'The run booked nothing, so nothing is held.',
    ])
  })

  it('says a reserve whose landing is unknown may be held, and that a referred charge can outlast the release', () => {
    const [, maybe, asked] = stoppedLines(
      new LoopStopped('The run stopped', null, {
        held: [
          {
            role: 'kept',
            link: 'https://try.testnet.avow.finance/#verify=maybe',
            reference: ref(3),
            reserve: 10_000_000n,
            releaseDate: 1_800_000_480n,
            chargeAsked: false,
            landed: 'unknown',
          },
          {
            role: 'cancelled',
            link: 'https://try.testnet.avow.finance/#verify=late',
            reference: ref(1),
            reserve: 10_000_000n,
            releaseDate: 1_800_000_480n,
            chargeAsked: true,
            landed: 'yes',
          },
        ],
      }),
    )
    expect(maybe).toContain('may hold $10')
    expect(maybe).toContain("didn't show whether it landed")
    expect(maybe).toContain('#verify=maybe')
    expect(asked).toContain('If Avow refers that charge to a ruling instead')
    expect(asked).toContain('can be after the release date')
  })
})
