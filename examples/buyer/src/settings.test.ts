import { describe, expect, it } from 'vitest'
import { enrollSettings } from './settings.js'

describe('enrollSettings', () => {
  it('names every missing setting and says where the settings come from', () => {
    expect(() => enrollSettings({})).toThrow(
      /^These settings are missing or wrong: .*BUYER_BUSINESS_ID.*\. Avow sends these when it registers you, and the quickstart's README lists each one\. Set them in this terminal\.$/,
    )
  })
})
