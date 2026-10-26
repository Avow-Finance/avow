import { describe, expect, it } from 'vitest'
import { packageName } from './index.js'

describe('sdk', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@avow-finance/sdk')
  })
})
