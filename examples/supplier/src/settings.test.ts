import { describe, expect, it } from 'vitest'
import { serveSettings } from './settings.js'

describe('serveSettings', () => {
  it('names every missing setting and says where the settings come from', () => {
    expect(() => serveSettings({})).toThrow(
      /^These settings are missing or wrong: .*AVOW_API_URL.*\. Avow sends these when it registers you, and the quickstart's README lists each one\. Set them in this terminal\.$/,
    )
  })
})
