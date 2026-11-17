import { describe, expect, it } from 'vitest'
import { readConnectArgs } from './connect.js'

describe('avow-sandbox connect', () => {
  it('takes the business ID and a name', () => {
    expect(readConnectArgs(['--business', 'sandbox-ab', '--name', 'Research agent'])).toEqual({
      businessId: 'sandbox-ab',
      label: 'Research agent',
      sell: false,
    })
    expect(readConnectArgs(['--business', 'sandbox-ab'])).toEqual({
      businessId: 'sandbox-ab',
      label: 'My agent',
      sell: false,
    })
    expect(readConnectArgs(['--sell', '--business', 'sandbox-ab'])).toEqual({
      businessId: 'sandbox-ab',
      label: 'My agent',
      sell: true,
    })
  })

  it('asks without a business when none is named, for whoever opens the link to approve', () => {
    expect(readConnectArgs([])).toEqual({ businessId: null, label: 'My agent', sell: false })
    expect(readConnectArgs(['--name', 'Research agent'])).toEqual({
      businessId: null,
      label: 'Research agent',
      sell: false,
    })
  })

  it('says what is missing or not taken', () => {
    expect(readConnectArgs(['--business'])).toEqual({ error: '--business needs a value' })
    expect(readConnectArgs(['--business', 'a', '--root', 'x'])).toEqual({
      error: "connect doesn't take --root",
    })
  })
})
