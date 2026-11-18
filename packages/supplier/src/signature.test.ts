import { describe, expect, it } from 'vitest'
import { isWebhookSecret, makeWebhookSecret, signWebhook, verifyWebhook } from './signature.js'

const SECRET = makeWebhookSecret()
const NOW = 1_800_000_000

describe('webhook signatures', () => {
  it('match the Standard Webhooks test vector, so any of its libraries can check a delivery', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
    const body = '{"test": 2432232314}'
    const signature = signWebhook(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', '1614265330', body)
    expect(signature).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
    const headers = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature }
    expect(verifyWebhook(secret, headers, body, 1614265330)).toBe(true)
  })

  it('refuse another body, another secret, an old or future timestamp, and accept one of several signatures', () => {
    const body = '{"a":1}'
    const signature = signWebhook(SECRET, 'msg_1', String(NOW), body)
    const headers = { id: 'msg_1', timestamp: String(NOW), signature }
    expect(verifyWebhook(SECRET, headers, body, NOW)).toBe(true)
    expect(verifyWebhook(SECRET, headers, '{"a":2}', NOW)).toBe(false)
    expect(verifyWebhook(makeWebhookSecret(), headers, body, NOW)).toBe(false)
    expect(verifyWebhook(SECRET, headers, body, NOW + 301)).toBe(false)
    expect(verifyWebhook(SECRET, headers, body, NOW - 301)).toBe(false)
    const rotated = { ...headers, signature: `v1,bm90IGl0 ${signature}` }
    expect(verifyWebhook(SECRET, rotated, body, NOW)).toBe(true)
  })

  it('take only a timestamp in whole decimal seconds, and sign it as the header carries it', () => {
    const body = '{"a":1}'
    for (const timestamp of [' 1800000000', '1.8e9', '0x6b49d200', 'soon', '']) {
      const signature = signWebhook(SECRET, 'msg_1', timestamp, body)
      expect(
        verifyWebhook(SECRET, { id: 'msg_1', timestamp, signature }, body, NOW),
        timestamp,
      ).toBe(false)
    }
  })

  it('make secrets of 32 random bytes and take only well-formed ones', () => {
    expect(isWebhookSecret(SECRET)).toBe(true)
    expect(makeWebhookSecret()).not.toBe(SECRET)
    expect(Buffer.from(SECRET.slice('whsec_'.length), 'base64')).toHaveLength(32)
    for (const bad of ['', 'secret', 'whsec_short', `wh_${SECRET.slice(6)}`]) {
      expect(isWebhookSecret(bad), bad).toBe(false)
    }
  })
})
