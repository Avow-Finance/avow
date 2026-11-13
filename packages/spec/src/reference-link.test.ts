import { describe, expect, it } from 'vitest'
import { decodeCommitmentReference, encodeCommitmentReference } from './reference-link.js'
import type { CommitmentReference } from './references.js'

const reference: CommitmentReference = {
  kind: 'commitment',
  chainId: 42431,
  lock: '0x00000000000000000000000000000000000010c4',
  commitmentId: `0x${'ab'.repeat(32)}`,
  side: 'buyer',
  termsHash: `0x${'cd'.repeat(32)}`,
}

describe('commitment reference tokens', () => {
  it('reads back the reference a token was made from, and fits a URL fragment as it is', () => {
    const token = encodeCommitmentReference(reference)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCommitmentReference(token)).toEqual({ ok: true, value: reference })
    expect(new URL(`https://try.testnet.avow.finance/#verify=${token}`).hash).toBe(
      `#verify=${token}`,
    )
  })

  it('gives one token for one reference, whatever the letter case of its hex', () => {
    const upper = { ...reference, lock: reference.lock.toUpperCase().replace('0X', '0x') }
    expect(encodeCommitmentReference(upper as CommitmentReference)).toBe(
      encodeCommitmentReference(reference),
    )
  })

  it("won't make a token from anything but a commitment reference", () => {
    const payment = { ...reference, kind: 'payment' } as unknown as CommitmentReference
    expect(() => encodeCommitmentReference(payment)).toThrow(RangeError)
  })

  it('reads a token a terminal broke across lines, with the breaks copied as spaces', () => {
    const token = encodeCommitmentReference(reference)
    const broken = `${token.slice(0, 40)} ${token.slice(40, 90)}\n${token.slice(90)}`
    expect(decodeCommitmentReference(broken)).toEqual(decodeCommitmentReference(token))
    expect(decodeCommitmentReference(`${token.slice(0, 40)}%20${token.slice(40)}`).ok).toBe(true)
  })

  it('refuses a token that is empty, too long, out of form or not a commitment reference', () => {
    const json = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    for (const token of [
      '',
      'a'.repeat(2000),
      'not a token!',
      'e30',
      json({ ...reference, side: 'nobody' }),
      json({ ...reference, extra: true }),
    ]) {
      expect(decodeCommitmentReference(token).ok).toBe(false)
    }
  })
})
