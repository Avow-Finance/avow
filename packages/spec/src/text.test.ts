import { describe, expect, it } from 'vitest'
import { isPlainText, markedUnplain, unplainMarks } from './text.js'

/** The invisible characters a format-character rule catches, and those beside it no rule did. */
const UNSEEN = [
  0x600, 0x605, 0x6dd, 0x70f, 0x8e2, 0x110bd, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a,
  0x34f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef,
]

const hex = (c: number) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`

describe('characters that show nothing', () => {
  it('keeps text holding any format character, variation selector or grapheme joiner from being plain', () => {
    for (const c of UNSEEN) {
      const text = `North${String.fromCodePoint(c)}wind`
      expect(isPlainText(text, 120), hex(c)).toBe(false)
      expect(unplainMarks(text), hex(c)).toEqual([{ at: 6, codePoint: c, kind: 'unseen' }])
      expect(markedUnplain(text), hex(c)).toBe(`North[${hex(c)}]wind`)
    }
  })

  it('marks U+FE0F after anything but a pictograph, where it only hides', () => {
    expect(isPlainText('North\ufe0fwind', 120)).toBe(false)
    expect(isPlainText('\u2764\ufe0f', 120)).toBe(true)
    expect(isPlainText('\u2764\ufe0e', 120)).toBe(false)
  })

  it('still takes letters, digits, punctuation and emoji that show', () => {
    for (const text of [
      'Northwind Labs',
      'Société Générale',
      '北風 研究所',
      "O'Brien & Sons",
      'Zebra 🦓',
      'Love \u2764\ufe0f Labs',
    ]) {
      expect(isPlainText(text, 120), text).toBe(true)
    }
  })
})
