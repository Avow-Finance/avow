import { SPEAKER_NAME, speakerName } from '@avow-finance/spec'
import { lookOf, SPEAKER_NAME as RAIL_SPEAKER_NAME, Rail } from '@avow-finance/terminal'
import { describe, expect, it } from 'vitest'

describe("a speaker's name", () => {
  it('follows one rule in the spec and on the rail', () => {
    expect(SPEAKER_NAME.source).toBe(RAIL_SPEAKER_NAME.source)
    expect(SPEAKER_NAME.flags).toBe(RAIL_SPEAKER_NAME.flags)
  })

  it('is drawn by the rail for any model id speakerName is given', () => {
    const rail = new Rail(lookOf({ isTTY: false, columns: 80 }, {}), () => {})
    for (const id of [
      'qwen3:8b',
      'llama3.1:8b',
      'claude-sonnet-5-5',
      '@cf/meta/llama-3.1-8b-instruct',
      '-qwen',
      ':latest',
      'hf.co/org/model\u001b[31m',
      ' ',
      'x'.repeat(80),
    ]) {
      expect(() => rail.said(speakerName(id), 'Hello.'), id).not.toThrow()
    }
  })
})
