import { describe, expect, it } from 'vitest'
import { canonicalJson, newSalt } from './canonical.js'
import { testnetDemoTerms } from './demo.js'
import { ARBITER } from './test-helpers.js'

const START = 1_800_000_000n

describe('canonicalJson', () => {
  it('sorts keys at every depth and writes bigints as strings', () => {
    expect(canonicalJson({ b: 1n, a: { d: [2n, 'x'], c: true } })).toBe(
      '{"a":{"c":true,"d":["2","x"]},"b":"1"}',
    )
  })

  it('gives the same bytes whatever order the keys were written in', () => {
    const terms = testnetDemoTerms(START, ARBITER)
    const reversed = Object.fromEntries(Object.entries(terms).reverse())
    expect(canonicalJson(reversed)).toBe(canonicalJson(terms))
  })

  it('leaves out undefined fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('sorts keys by UTF-16 code units, as the RFC 8785 example does', () => {
    // RFC 8785, section 3.2.3.
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    }
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",' +
        '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",' +
        '"😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    )
  })

  it('escapes strings as RFC 8785 does', () => {
    expect(canonicalJson('\u0000\b\t\n\f\r"\\/\u001f\u007fé')).toBe(
      '"\\u0000\\b\\t\\n\\f\\r\\"\\\\/\\u001f\u007fé"',
    )
  })

  it('refuses any number but a safe integer, so amounts and times never pass through a float', () => {
    for (const n of [1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => canonicalJson({ a: n }), String(n)).toThrow()
    }
    expect(canonicalJson({ a: 2 ** 53 - 1, b: -3, c: 0 })).toBe(
      '{"a":9007199254740991,"b":-3,"c":0}',
    )
  })

  it('refuses a string or key that is half a character', () => {
    expect(() => canonicalJson('\ud800')).toThrow()
    expect(() => canonicalJson({ '\udc00': 1 })).toThrow()
    expect(canonicalJson('😀')).toBe('"😀"')
  })

  it('refuses values JSON would change or drop', () => {
    expect(() => canonicalJson({ a: () => 1 })).toThrow()
    expect(() => canonicalJson({ a: Symbol('s') })).toThrow()
  })
})

describe('newSalt', () => {
  it('makes a fresh 32-byte salt each time', () => {
    const a = newSalt()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(newSalt()).not.toBe(a)
  })
})
