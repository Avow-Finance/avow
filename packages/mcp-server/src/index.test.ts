import { describe, expect, it } from 'vitest'
import { packageName } from './index.js'

describe('mcp-server', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@avow-finance/mcp-server')
  })
})
