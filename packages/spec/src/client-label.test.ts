import { describe, expect, it } from 'vitest'
import { clientLabelOf } from './client-label.js'

describe("an agent's client label", () => {
  it('reads a short label, trimmed', () => {
    expect(clientLabelOf(' MCP: claude-code ')).toBe('MCP: claude-code')
    expect(clientLabelOf('Terminal')).toBe('Terminal')
  })

  it('refuses nothing, too much, and anything that could be markup or a second header', () => {
    expect(clientLabelOf(undefined)).toBeNull()
    expect(clientLabelOf('   ')).toBeNull()
    expect(clientLabelOf('x'.repeat(61))).toBeNull()
    expect(clientLabelOf('<script>')).toBeNull()
    expect(clientLabelOf('a\r\nset-cookie: x')).toBeNull()
  })
})
