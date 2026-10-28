import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import { assertTestSettingsOnTestnet, TEMPO_MODERATO } from './networks.js'
import { toTokenUnits } from './rail.js'
import { MemoryReplayGuard } from './replay.js'
import { PRODUCTION_PROFILE, TESTNET_DEMO_PROFILE } from './terms.js'

describe('toTokenUnits', () => {
  it('leaves micros as they are for a 6-decimal token, like every TIP-20', () => {
    expect(toTokenUnits(dollars(500), 6)).toBe(500_000_000n)
  })

  it('scales up for more decimals', () => {
    expect(toTokenUnits(dollars(1), 18)).toBe(10n ** 18n)
  })

  it('scales down for fewer decimals only when the amount fits exactly', () => {
    expect(toTokenUnits(dollars(5), 2)).toBe(500n)
    expect(() => toTokenUnits(1n, 2)).toThrow()
  })

  it('refuses a decimals value no token has', () => {
    expect(() => toTokenUnits(1n, -1)).toThrow()
    expect(() => toTokenUnits(1n, 6.5)).toThrow()
  })
})

describe('MemoryReplayGuard', () => {
  it('records a key once', async () => {
    const guard = new MemoryReplayGuard()
    expect(await guard.isRecorded('a')).toBe(false)
    expect(await guard.recordAll([{ key: 'a', expiry: 100n }])).toBe(true)
    expect(await guard.isRecorded('a')).toBe(true)
    expect(await guard.recordAll([{ key: 'a', expiry: 100n }])).toBe(false)
  })

  it('records a set of keys together or not at all', async () => {
    const guard = new MemoryReplayGuard()
    await guard.recordAll([{ key: 'used', expiry: 100n }])
    expect(
      await guard.recordAll([
        { key: 'fresh', expiry: 100n },
        { key: 'used', expiry: 100n },
      ]),
    ).toBe(false)
    expect(await guard.isRecorded('fresh')).toBe(false)
    expect(
      await guard.recordAll([
        { key: 'twice', expiry: 100n },
        { key: 'twice', expiry: 100n },
      ]),
    ).toBe(false)
  })

  it('forgets keys only once their messages have expired', async () => {
    const guard = new MemoryReplayGuard()
    await guard.recordAll([{ key: 'a', expiry: 100n }])
    await guard.recordAll([{ key: 'b', expiry: 200n }])
    guard.prune(150n)
    expect(await guard.isRecorded('a')).toBe(false)
    expect(await guard.isRecorded('b')).toBe(true)
  })
})

describe('assertTestSettingsOnTestnet', () => {
  it('lets test data and the demo profile run on Moderato only', () => {
    const demo = { chainId: TEMPO_MODERATO, testData: true, profile: TESTNET_DEMO_PROFILE }
    expect(() => assertTestSettingsOnTestnet(demo)).not.toThrow()
    expect(() => assertTestSettingsOnTestnet({ ...demo, chainId: 7777 })).toThrow()
    expect(() => assertTestSettingsOnTestnet({ ...demo, chainId: 7777, testData: false })).toThrow()
    expect(() =>
      assertTestSettingsOnTestnet({
        chainId: 7777,
        testData: false,
        profile: PRODUCTION_PROFILE,
      }),
    ).not.toThrow()
    // A short window can't pass by calling itself production.
    expect(() =>
      assertTestSettingsOnTestnet({
        chainId: 7777,
        testData: false,
        profile: { ...PRODUCTION_PROFILE, minContestWindow: 600n },
      }),
    ).toThrow()
  })
})
