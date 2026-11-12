import { describe, expect, it } from 'vitest'
import { readConnectArgs } from './connect.js'

describe('avow-sandbox connect', () => {
  it('takes the business ID and a name', () => {
    expect(readConnectArgs(['--business', 'sandbox-ab', '--name', 'Research agent'])).toEqual({
      businessId: 'sandbox-ab',
      label: 'Research agent',
    })
    expect(readConnectArgs(['--business', 'sandbox-ab'])).toEqual({
      businessId: 'sandbox-ab',
      label: 'My agent',
    })
  })

  it('says what is missing, and points at the console for the business ID', () => {
    expect(readConnectArgs([])).toEqual({ error: expect.stringContaining('testnet.avow.finance') })
    expect(readConnectArgs(['--business'])).toEqual({ error: '--business needs a value' })
    expect(readConnectArgs(['--business', 'a', '--root', 'x'])).toEqual({
      error: "connect doesn't take --root",
    })
  })
})
