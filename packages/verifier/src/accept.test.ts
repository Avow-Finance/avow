import { type Approval, termsHash, testnetDemoTerms } from '@avow-finance/spec'
import { type Address, type Hex, keccak256, stringToHex, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { prepareAcceptance } from './accept.js'

const id = (label: string): Hex => keccak256(stringToHex(label))
const address = (label: string): Address => `0x${id(label).slice(-40)}`

const START = 1_800_000_000n
const terms = testnetDemoTerms(START)
const domain = { chainId: 42431, verifyingContract: address('lock') }

// Avow's approval for the demo terms, matching them in every field the terms carry. The day-90
// share and the arbiter are Avow's, since the terms have no field for either.
const approval: Approval = {
  commitmentId: id('commitment'),
  side: 'buyer',
  token: '0x20c0000000000000000000000000000000000001',
  amount: terms.reserve,
  supplier: address('supplier account'),
  supplierSigner: address('supplier signing key'),
  payee: address('supplier payout'),
  freeCancelBy: terms.freeCancelBy,
  acceptBy: terms.acceptBy,
  chargeDeadline: terms.chargeDeadline,
  releaseDate: terms.releaseDate,
  contestWindow: terms.contestWindow,
  charges: [
    { kind: 'lateCancellation', most: terms.lateCancellation, earliest: terms.freeCancelBy },
    { kind: 'noShow', most: terms.noShow, earliest: terms.windowStart + terms.gracePeriod },
  ],
  day90SupplierShareBps: 5000,
  arbiter: address('arbiter'),
  termsHash: termsHash(terms, `0x${'55'.repeat(32)}`),
  mandateHash: id('mandate'),
  capPerCommitment: terms.reserve,
  capOpenReserves: 2n * terms.reserve,
  fundingKey: zeroAddress,
  nonce: 1n,
  expiry: START,
}

describe('prepareAcceptance', () => {
  it('builds no acceptance while the terms lack the day-90 share and the arbiter', () => {
    expect(prepareAcceptance({ approval, terms, domain })).toEqual({
      ok: false,
      reason: 'terms.incomplete',
    })
  })

  it('builds none for an approval that differs from the terms either', () => {
    const later = { ...approval, freeCancelBy: approval.freeCancelBy + 600n }
    expect(prepareAcceptance({ approval: later, terms, domain })).toEqual({
      ok: false,
      reason: 'terms.incomplete',
    })
  })
})
