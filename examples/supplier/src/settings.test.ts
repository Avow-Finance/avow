import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { envKeys, serveSettings } from './settings.js'

const KEY = `0x${'1a'.repeat(32)}`
const ACCOUNT = '0x00000000000000000000000000000000000a11ce'
const SERVE = {
  AVOW_API_URL: 'https://api.testnet.avow.finance',
  AVOW_FACTORY: '0x8fa7177c84be069df2a51f096ed28d5d661b8283',
  AVOW_TOKEN: '0x20c00000000000000000000058fbf8a39a171185',
  AVOW_APPROVAL_KEYS: '0x76636e9a12c33fd7c0cb3b092bf87677eec53640',
  SUPPLIER_BUSINESS_ID: 'biz_supplier',
}

describe('serveSettings', () => {
  it('names every missing setting and says where the settings come from', () => {
    expect(() => serveSettings({})).toThrow(
      /^These settings are missing or wrong: .*AVOW_API_URL.*\. Avow sends these when it registers you, and the quickstart's README lists each one\. Set them in this terminal\.$/,
    )
  })

  it('holds 5 open bookings for one buyer and 200 in all unless told otherwise', () => {
    expect(serveSettings(SERVE)).toMatchObject({ maxOpenPerBuyer: 5, maxOpenBookings: 200 })
    const set = serveSettings({ ...SERVE, MAX_OPEN_PER_BUYER: '2', MAX_OPEN_BOOKINGS: '20' })
    expect(set).toMatchObject({ maxOpenPerBuyer: 2, maxOpenBookings: 20 })
    expect(() => serveSettings({ ...SERVE, MAX_OPEN_PER_BUYER: '0' })).toThrow('MAX_OPEN_PER_BUYER')
  })
})

describe('envKeys', () => {
  it('leaves the keys to the keys file when the environment holds neither setting', () => {
    expect(envKeys({})).toBeNull()
    expect(envKeys({ SUPPLIER_SIGNING_KEY: ' ', SUPPLIER_ACCOUNT: '' })).toBeNull()
  })

  it('takes the signing key and the account address together', () => {
    expect(envKeys({ SUPPLIER_SIGNING_KEY: KEY, SUPPLIER_ACCOUNT: ACCOUNT })).toEqual({
      signingKey: KEY,
      account: getAddress(ACCOUNT),
    })
  })

  it('names the one that is missing or wrong, and never prints the key', () => {
    expect(() => envKeys({ SUPPLIER_SIGNING_KEY: KEY })).toThrow(
      /^These settings are missing or wrong: SUPPLIER_ACCOUNT\./,
    )
    expect(() => envKeys({ SUPPLIER_SIGNING_KEY: `${KEY}00`, SUPPLIER_ACCOUNT: ACCOUNT })).toThrow(
      /: SUPPLIER_SIGNING_KEY\./,
    )
    try {
      envKeys({ SUPPLIER_SIGNING_KEY: `${KEY}00`, SUPPLIER_ACCOUNT: ACCOUNT })
    } catch (e) {
      expect(String(e)).not.toContain(KEY)
    }
  })
})
