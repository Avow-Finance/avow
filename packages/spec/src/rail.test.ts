import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import { toTokenUnits } from './rail.js'
import { MemoryReplayGuard } from './replay.js'

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
  it('lets a key through once', async () => {
    const guard = new MemoryReplayGuard()
    expect(await guard.recordOnce('Approval:0xabc:1', 100n)).toBe(true)
    expect(await guard.recordOnce('Approval:0xabc:1', 100n)).toBe(false)
    expect(await guard.recordOnce('Approval:0xabc:2', 100n)).toBe(true)
  })

  it('forgets keys only once their messages have expired', async () => {
    const guard = new MemoryReplayGuard()
    await guard.recordOnce('a', 100n)
    await guard.recordOnce('b', 200n)
    guard.prune(150n)
    expect(await guard.recordOnce('a', 300n)).toBe(true)
    expect(await guard.recordOnce('b', 300n)).toBe(false)
  })
})
