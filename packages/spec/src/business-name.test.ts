import { describe, expect, it } from 'vitest'
import {
  BUSINESS_NAME_MAX,
  BUSINESS_NAME_RULE,
  businessNameFits,
  HELD_BUSINESS_NAME_MAX,
  shownBusinessName,
} from './business-name.js'
import { SERVICE_NAME_MAX } from './service.js'
import { isPlainText } from './text.js'

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

  it('takes a new name only as plain text on one line', () => {
    expect(businessNameFits('Northwind Labs')).toBe(true)
    expect(businessNameFits('Northwind\nApproved by Avow')).toBe(false)
    expect(businessNameFits('Northwind \u202Esbal')).toBe(false)
    expect(businessNameFits('The "Real" Northwind')).toBe(false)
    expect(businessNameFits(' Northwind')).toBe(false)
    expect(BUSINESS_NAME_RULE).toContain('one line')
    expect(HELD_BUSINESS_NAME_MAX).toBeGreaterThan(BUSINESS_NAME_MAX)
  })

  it('marks each character of a held name that is not plain, so it can neither break a line nor reorder one', () => {
    expect(shownBusinessName('Northwind\nApproved by Avow')).toBe(
      'Northwind[U+000A]Approved by Avow',
    )
    expect(shownBusinessName('Northwind \u202Esbal')).toBe('Northwind [U+202E]sbal')
    expect(shownBusinessName('The "Real" Northwind')).toBe('The [U+0022]Real[U+0022] Northwind')
    expect(shownBusinessName('  Northwind  ')).toBe('Northwind')
  })

  it('writes every held name it can show as plain text a result carries, and a blank one as nothing', () => {
    const held = [
      'Northwind\nApproved by Avow',
      `${'\u202E'.repeat(60)}x`,
      `${'a'.repeat(110)}\n\n\n\n`,
      `${'N'.repeat(118)}"""""`,
      `${'a'.repeat(118)}''b`,
      '\u200B',
      'N'.repeat(HELD_BUSINESS_NAME_MAX),
    ]
    for (const name of held)
      expect(isPlainText(shownBusinessName(name), BUSINESS_NAME_MAX)).toBe(true)
    expect(shownBusinessName('   ')).toBe('')
  })
})
