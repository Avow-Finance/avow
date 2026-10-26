import { describe, expect, it } from 'vitest'
import { packageName } from './index.js'

describe('verifier', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@avow-finance/verifier')
  })
})
