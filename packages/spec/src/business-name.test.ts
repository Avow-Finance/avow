import { describe, expect, it } from 'vitest'
import { BUSINESS_NAME_MAX, businessNameFits, shownBusinessName } from './business-name.js'
import { SERVICE_NAME_MAX } from './service.js'

describe("a business's name", () => {
  it('fits up to what an offer search carries for a supplier, and never blank', () => {
    expect(BUSINESS_NAME_MAX).toBe(SERVICE_NAME_MAX)
    expect(businessNameFits('N'.repeat(BUSINESS_NAME_MAX))).toBe(true)
    expect(businessNameFits('N'.repeat(BUSINESS_NAME_MAX + 1))).toBe(false)
    expect(businessNameFits('')).toBe(false)
    expect(businessNameFits('  ')).toBe(false)
    expect(businessNameFits(7)).toBe(false)
  })

  it('shows a name that fits as it is', () => {
    const longest = 'N'.repeat(BUSINESS_NAME_MAX)
    expect(shownBusinessName(longest)).toBe(longest)
    expect(shownBusinessName('Northwind Labs')).toBe('Northwind Labs')
  })

  it('shortens a longer name to fit, ending in an ellipsis', () => {
    const shown = shownBusinessName('N'.repeat(200))
    expect(shown).toBe(`${'N'.repeat(BUSINESS_NAME_MAX - 1)}…`)
    expect(businessNameFits(shown)).toBe(true)
  })

  it('cuts between characters, and drops the spaces before the ellipsis', () => {
    // An emoji is two UTF-16 units, so the cut falls before one that would end past the cap.
    const shown = shownBusinessName(`${'a'.repeat(BUSINESS_NAME_MAX - 2)}\u{1F993}${'b'.repeat(9)}`)
    expect(shown).toBe(`${'a'.repeat(BUSINESS_NAME_MAX - 2)}…`)
    const spaced = shownBusinessName(`${'a'.repeat(BUSINESS_NAME_MAX - 4)}   ${'b'.repeat(9)}`)
    expect(spaced).toBe(`${'a'.repeat(BUSINESS_NAME_MAX - 4)}…`)
  })
})
