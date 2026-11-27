import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { envKeys, registrationSettings, serveSettings } from './settings.js'
import { makeWebhookSecret } from './signature.js'

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
      /^These settings are missing or wrong: .*AVOW_API_URL.*\. The README lists each one and where it comes from\. Set them in this terminal\.$/,
    )
  })

  it('holds 5 open bookings for one buyer and 200 in all unless told otherwise', () => {
    expect(serveSettings(SERVE)).toMatchObject({ maxOpenPerBuyer: 5, maxOpenBookings: 200 })
    const set = serveSettings({ ...SERVE, MAX_OPEN_PER_BUYER: '2', MAX_OPEN_BOOKINGS: '20' })
    expect(set).toMatchObject({ maxOpenPerBuyer: 2, maxOpenBookings: 20 })
    expect(() => serveSettings({ ...SERVE, MAX_OPEN_PER_BUYER: '0' })).toThrow('MAX_OPEN_PER_BUYER')
  })
})

describe('the webhook and the local port', () => {
  const SECRET = makeWebhookSecret()

  it('posts nowhere and answers checks on the loopback address at 8791 unless told otherwise', () => {
    expect(serveSettings(SERVE)).toMatchObject({
      webhook: null,
      localHost: '127.0.0.1',
      localPort: 8791,
    })
  })

  it('takes an https webhook with its secret, or http to this machine', () => {
    const url = 'https://bookings.example/avow'
    expect(serveSettings({ ...SERVE, WEBHOOK_URL: url, WEBHOOK_SECRET: SECRET }).webhook).toEqual({
      url,
      secret: SECRET,
    })
    const near = { ...SERVE, WEBHOOK_URL: 'http://localhost:4000/avow', WEBHOOK_SECRET: SECRET }
    expect(serveSettings(near).webhook?.url).toBe('http://localhost:4000/avow')
  })

  it('refuses a webhook without a good secret, plain http to another machine, and a secret with no webhook', () => {
    const url = 'https://bookings.example/avow'
    expect(() => serveSettings({ ...SERVE, WEBHOOK_URL: url })).toThrow('WEBHOOK_SECRET')
    expect(() => serveSettings({ ...SERVE, WEBHOOK_URL: url, WEBHOOK_SECRET: 'hunter2' })).toThrow(
      'WEBHOOK_SECRET',
    )
    const plain = { ...SERVE, WEBHOOK_URL: 'http://bookings.example/avow', WEBHOOK_SECRET: SECRET }
    expect(() => serveSettings(plain)).toThrow('WEBHOOK_URL')
    expect(() =>
      serveSettings({ ...SERVE, WEBHOOK_URL: 'not a url', WEBHOOK_SECRET: SECRET }),
    ).toThrow('WEBHOOK_URL')
    expect(() => serveSettings({ ...SERVE, WEBHOOK_SECRET: SECRET })).toThrow('WEBHOOK_URL')
  })

  it('never puts the secret in an error', () => {
    const plain = { ...SERVE, WEBHOOK_URL: 'http://bookings.example/avow', WEBHOOK_SECRET: SECRET }
    expect(() => serveSettings(plain)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(SECRET) }),
    )
  })

  it('refuses a webhook URL with a user name or password, and a local host that is no address', () => {
    const withLogin = {
      ...SERVE,
      WEBHOOK_URL: 'https://me:pw@bookings.example/avow',
      WEBHOOK_SECRET: SECRET,
    }
    expect(() => serveSettings(withLogin)).toThrow('WEBHOOK_URL')
    expect(() => serveSettings({ ...SERVE, LOCAL_HOST: 'bookings.example' })).toThrow('LOCAL_HOST')
    expect(serveSettings({ ...SERVE, LOCAL_HOST: 'localhost' }).localHost).toBe('localhost')
  })

  it('refuses a local port that is the agents port', () => {
    expect(() => serveSettings({ ...SERVE, PORT: '9000', LOCAL_PORT: '9000' })).toThrow(
      'LOCAL_PORT',
    )
    expect(serveSettings({ ...SERVE, LOCAL_HOST: '0.0.0.0', LOCAL_PORT: '9001' })).toMatchObject({
      localHost: '0.0.0.0',
      localPort: 9001,
    })
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

describe('registrationSettings', () => {
  it("leaves init to the published deployment unless Avow's API and factory are both set", () => {
    expect(registrationSettings({})).toBeNull()
    expect(registrationSettings({ AVOW_FACTORY: SERVE.AVOW_FACTORY })).toBeNull()
    expect(registrationSettings({ AVOW_API_URL: SERVE.AVOW_API_URL })).toBeNull()
    expect(
      registrationSettings({ AVOW_API_URL: SERVE.AVOW_API_URL, AVOW_FACTORY: SERVE.AVOW_FACTORY }),
    ).toEqual({
      chainId: 42431,
      apiUrl: SERVE.AVOW_API_URL,
      factory: getAddress(SERVE.AVOW_FACTORY),
    })
  })

  it('refuses a set pair that is wrong, naming each setting', () => {
    expect(() =>
      registrationSettings({ AVOW_API_URL: 'https://api.example/v1', AVOW_FACTORY: 'nope' }),
    ).toThrow(/missing or wrong: AVOW_API_URL, AVOW_FACTORY\./)
  })
})
